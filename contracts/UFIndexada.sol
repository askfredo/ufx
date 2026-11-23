// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./Canasta.sol"; // TokenPrueba, OraculoPrueba, MercadoPrueba

// ════════════════════════════════════════════════════════════════════
//  UFX: "UF Global", una unidad de ahorro para personas y agentes de IA.
//  - 1 UFX = $1 al comienzo. Se llevan DOS índices acumulados por separado desde el inicio:
//        pata IPC:     inflación + tasa fija   (como un depósito en "UF + x%")
//        pata T-bills: T-bills + margen        (para ganarle siempre a las stablecoins)
//    El precio es el mayor de los dos, y nunca baja. Comparar índices acumulados (y no mes a mes)
//    evita el "trinquete": las bajas estacionales del IPC no se convierten en ganancia extra.
//    IPC: CPI-U sin ajuste estacional (como los TIPS), primera publicación, con un mes de rezago. UFX es un ERC-20 normal: se transfiere barato y sin sorpresas.
//  - Respaldo: una canasta de activos reales, rebalanceada automáticamente.
//  - COLCHÓN (token UFXC): absorbe las subidas y bajadas de la canasta y se queda con
//    todo lo que sobra por sobre lo que se debe a UFX. Es transable: cualquiera puede
//    comprarlo o venderlo en un exchange.
//  - FASE DE ARRANQUE: primero se arma el colchón; UFX se abre al llegar a `metaArranque`.
//    Después, entrar al colchón cuesta `cuotaEntradaBps` (queda para los que ya estaban) y
//    salir antes de un año cuesta `multaSalidaBps`.
//  - COMISIÓN DEL FUNDADOR: `comisionBps` anual sobre la reserva, en UFXC, desde el segundo año.
//  - MANTENCIÓN: cualquiera (un bot) puede llamar `mantener()` una vez al día: actualiza el
//    precio, rebalancea cuando toca y cobra una propina chica (`recompensaUsd`) en UFXC.
//  - Seguridad: solo se crean UFX si el respaldo queda ≥ 120%. Salir siempre se puede.
//  - CORTACIRCUITO DEL IPC: si el dato de inflación no llega o salta fuera de un rango razonable
//    (más de +2% o -1% por mes), se ignora y UFX sigue creciendo con la pata de T-bills.
//    El contrato nunca se traba por el oráculo de inflación.
//  - MODO DEFENSIVO: si el respaldo cae bajo `umbralDefensivoBps`, la canasta pasa a pesos
//    defensivos (más bonos y oro); vuelve a los normales cuando el respaldo sube 10 puntos sobre el umbral.
// ════════════════════════════════════════════════════════════════════

/// Partes del colchón como token transable. Solo el contrato UFX las crea y las quema.
contract ParteColchon is ERC20 {
    UFIndexada public immutable ufx;

    constructor() ERC20("UF Global Colchon", "UFXC") {
        ufx = UFIndexada(msg.sender);
    }

    function acunar(address a, uint256 m) external {
        require(msg.sender == address(ufx), "solo UFX");
        _mint(a, m);
    }

    function quemar(address a, uint256 m) external {
        require(msg.sender == address(ufx), "solo UFX");
        _burn(a, m);
    }

    /// Al transferir, las partes llevan su antigüedad (para la multa de salida temprana).
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) ufx.registrarTransferenciaColchon(from, to);
        super._update(from, to, value);
    }
}

contract UFIndexada is ERC20, ReentrancyGuard, IERC4626 {
    using SafeERC20 for IERC20;

    struct Config {
        uint256 tasaFijaBps;     // tasa real fija anual sobre la inflación (200 = 2%)
        bool pisoStable;         // si está activo, UFX rinde al menos T-bills + margen
        uint256 margenBps;       // margen sobre los T-bills (50 = 0,5%)
        address fundador;        // recibe la comisión
        uint256 comisionBps;     // anual, sobre la reserva (10 = 0,1%)
        uint256 metaArranque;    // dólares de colchón para abrir UFX
        uint256 cuotaEntradaBps; // entrada al colchón después del arranque (200 = 2%)
        uint256 multaSalidaBps;  // salida del colchón antes de un año (100 = 1%)
        uint256 recompensaUsd;   // propina por `mantener()` (en dólares, 18 decimales)
        uint256 rebalanceoCada;  // segundos entre rebalanceos automáticos
        uint256 umbralDefensivoBps; // respaldo bajo el cual se usan los pesos defensivos (0 = apagado)
    }

    /// Clave del oráculo para el índice de precios (1e18 = $1 al inicio).
    address public constant IPC = address(uint160(uint256(keccak256("IPC global"))));
    /// Clave del oráculo para la tasa anual de los T-bills (1e18 = 100%).
    address public constant TBILL = address(uint160(uint256(keccak256("Tasa T-bill"))));
    uint256 public constant RATIO_MIN = 12000; // 120%
    uint256 public constant DURACION_ANIO = 31557600; // 365,25 días
    uint256 public constant MANTENCION_CADA = 1 days;
    uint256 public constant IPC_SUBIDA_MAX_MES_BPS = 200; // +2% por mes como máximo
    uint256 public constant IPC_BAJADA_MAX_MES_BPS = 100; // -1% por mes como máximo
    uint256 public constant SALIDA_DEFENSIVO_BPS = 1000;  // sale del modo defensivo 10 puntos sobre el umbral

    TokenPrueba public immutable dolar;
    MercadoPrueba public immutable mercado;
    IOraculo public immutable oraculo; // en la red de prueba: OraculoMediana sobre varias fuentes
    ParteColchon public immutable partes;

    TokenPrueba[] public activos;
    uint256[] public pesosBps;
    uint256[] public pesosDefensivosBps;
    uint256 public immutable umbralDefensivoBps;
    bool public modoDefensivo;

    uint256 public immutable tasaFijaBps;
    bool public immutable pisoStable;
    uint256 public immutable margenBps;
    uint256 public immutable comisionBps;
    uint256 public immutable metaArranque;
    uint256 public immutable cuotaEntradaBps;
    uint256 public immutable multaSalidaBps;
    uint256 public immutable recompensaUsd;
    uint256 public immutable rebalanceoCada;

    address public fundador;
    uint256 public abiertoDesde;        // 0 mientras dura el arranque
    mapping(address => uint256) public desdeColchon;
    uint256 public tComision;
    uint256 public ultimaMantencion;
    uint256 public ultimoRebalanceo;

    // Precio guardado en la última actualización (se va acumulando).
    uint256 public precioGuardado = 1e18;
    uint256 public ipcGuardado;
    uint256 public tGuardado;
    uint256 public pataIpc = 1e18;    // índice acumulado: inflación + tasa fija
    uint256 public pataTbill = 1e18;  // índice acumulado: T-bills + margen
    uint256 public tIpcCambio;   // cuándo cambió por última vez el IPC aceptado
    uint256 public tbillGuardado; // última tasa de T-bills válida

    event Acunado(address indexed quien, address indexed receptor, uint256 dolares, uint256 monedas);
    event Quemado(address indexed quien, address indexed receptor, uint256 monedas, uint256 dolares);
    event ColchonAportado(address indexed quien, uint256 dolares, uint256 partes);
    event ColchonRetirado(address indexed quien, uint256 partes, uint256 dolares);
    event Rebalanceado(uint256 valorTotal);
    event Mantenido(address indexed bot, uint256 recompensaPartes);
    event ComisionFundador(uint256 dolares, uint256 partes);
    event FundadorCambiado(address nuevo);
    event UFXAbierta(uint256 colchon);
    event IPCIgnorado(uint256 ipcRecibido, bool sinDato); // el cortacircuito descartó el dato
    event ModoDefensivo(bool activo, uint256 ratio);

    /// Antes de cualquier movimiento: guardar el precio de hoy y cobrar la comisión que toque.
    modifier alDia() {
        _actualizarPrecio();
        _cobrarComision();
        _;
    }

    constructor(
        TokenPrueba _dolar,
        MercadoPrueba _mercado,
        IOraculo _oraculo,
        TokenPrueba[] memory _activos,
        uint256[] memory _pesos,
        uint256[] memory _pesosDefensivos,
        Config memory c
    ) ERC20("UF Global", "UFX") {
        require(_activos.length == _pesos.length, "largos distintos");
        uint256 suma = 0;
        for (uint256 i = 0; i < _pesos.length; i++) suma += _pesos[i];
        require(suma == 10000, "los pesos deben sumar 100%");
        if (c.umbralDefensivoBps > 0) {
            require(_pesosDefensivos.length == _pesos.length, "pesos defensivos: largo distinto");
            suma = 0;
            for (uint256 i = 0; i < _pesosDefensivos.length; i++) suma += _pesosDefensivos[i];
            require(suma == 10000, "pesos defensivos deben sumar 100%");
            pesosDefensivosBps = _pesosDefensivos;
        }
        require(c.tasaFijaBps <= 1000, "tasa fija > 10%");
        require(c.comisionBps <= 100, "comision > 1%");
        require(c.cuotaEntradaBps <= 1000 && c.multaSalidaBps <= 1000, "cuota o multa > 10%");
        require(c.fundador != address(0), "direccion vacia");

        dolar = _dolar;
        mercado = _mercado;
        oraculo = _oraculo;
        activos = _activos;
        pesosBps = _pesos;
        partes = new ParteColchon();

        tasaFijaBps = c.tasaFijaBps;
        pisoStable = c.pisoStable;
        margenBps = c.margenBps;
        fundador = c.fundador;
        comisionBps = c.comisionBps;
        metaArranque = c.metaArranque;
        cuotaEntradaBps = c.cuotaEntradaBps;
        multaSalidaBps = c.multaSalidaBps;
        recompensaUsd = c.recompensaUsd;
        rebalanceoCada = c.rebalanceoCada;
        umbralDefensivoBps = c.umbralDefensivoBps;
        ultimoRebalanceo = block.timestamp;

        IERC20(address(dolar)).forceApprove(address(_mercado), type(uint256).max);
        for (uint256 i = 0; i < _activos.length; i++) IERC20(address(_activos[i])).forceApprove(address(_mercado), type(uint256).max);
    }

    // ─────────────────────────── lecturas ───────────────────────────

    /// Dólares que vale 1 UFX. Parte en $1 y nunca baja.
    function precioUnidad() public view returns (uint256) {
        return _calcular().precio;
    }

    /// Si hoy el dato de inflación se está usando (true) o el cortacircuito lo descarta (false).
    function ipcAceptado() external view returns (bool) {
        return _calcular().ipcOk;
    }

    /// Dólares que valen las UFX de `a` hoy.
    function valorEnDolares(address a) external view returns (uint256) {
        return (balanceOf(a) * precioUnidad()) / 1e18;
    }

    /// Cuántas UFX recibirías hoy por `usd` (0 si la creación está pausada o en arranque).
    function previewAcunar(uint256 usd) external view returns (uint256 monedas) {
        if (abiertoDesde == 0 || usd == 0) return 0;
        monedas = (usd * 1e18) / precioUnidad();
        uint256 d = ((totalSupply() + monedas) * precioUnidad()) / 1e18;
        if (((valorReserva() + usd) * 10000) / d < RATIO_MIN) return 0;
    }

    /// Cuántos dólares recibirías hoy por quemar `cant` UFX (con descuento si la reserva no alcanza).
    function previewQuemar(uint256 cant) public view returns (uint256 usd) {
        uint256 s = totalSupply();
        if (cant == 0 || s == 0) return 0;
        uint256 r = valorReserva();
        usd = (cant * precioUnidad()) / 1e18;
        if (r < deuda()) usd = (r * cant) / s;
    }

    /// Dólares que vale todo lo que hay en la reserva.
    function valorReserva() public view returns (uint256 total) {
        total = dolar.balanceOf(address(this));
        for (uint256 i = 0; i < activos.length; i++) {
            total += (activos[i].balanceOf(address(this)) * oraculo.precio(address(activos[i]))) / 1e18;
        }
    }

    /// Dólares que se les deben a quienes tienen UFX.
    function deuda() public view returns (uint256) {
        return (totalSupply() * precioUnidad()) / 1e18;
    }

    /// Lo que sobra por encima de la deuda: es de los dueños del colchón.
    function colchon() public view returns (uint256) {
        (uint256 r, uint256 d) = (valorReserva(), deuda());
        return r > d ? r - d : 0;
    }

    /// Reserva / deuda en bps (12000 = 120%).
    function ratio() public view returns (uint256) {
        uint256 d = deuda();
        return d == 0 ? type(uint256).max : (valorReserva() * 10000) / d;
    }

    /// Partes del colchón de `a` (atajo a `partes.balanceOf`).
    function partesColchon(address a) external view returns (uint256) {
        return partes.balanceOf(a);
    }

    function partesColchonTotal() public view returns (uint256) {
        return partes.totalSupply();
    }

    /// Dólares que vale una parte del colchón.
    function valorParteColchon() external view returns (uint256) {
        uint256 t = partesColchonTotal();
        return t == 0 ? 1e18 : (colchon() * 1e18) / t;
    }

    struct Activo {
        address token;
        uint256 saldo;         // cantidad que tiene el contrato
        uint256 precio;        // dólares por unidad según el oráculo
        uint256 valor;         // saldo × precio
        uint256 pesoActualBps; // peso real en la reserva
        uint256 pesoObjetivoBps; // peso objetivo (normal o defensivo)
    }

    struct Reserva {
        Activo[] activos;
        uint256 caja;          // dólares sin invertir
        uint256 total;         // valor de toda la reserva
        uint256 deuda;         // lo que se debe a quienes tienen UFX
        uint256 colchon;       // total - deuda
        uint256 ratioBps;      // respaldo
        uint256 precioUFX;
        uint256 ufxEnCirculacion;
        bool modoDefensivo;
        bool ipcAceptado;
    }

    /// Todo el respaldo en una sola lectura, para verificarlo sin confiar en nadie.
    function reservaDetalle() external view returns (Reserva memory r) {
        r.caja = dolar.balanceOf(address(this));
        r.total = r.caja;
        r.activos = new Activo[](activos.length);
        for (uint256 i = 0; i < activos.length; i++) {
            Activo memory a = r.activos[i];
            a.token = address(activos[i]);
            a.saldo = activos[i].balanceOf(address(this));
            a.precio = oraculo.precio(a.token);
            a.valor = (a.saldo * a.precio) / 1e18;
            a.pesoObjetivoBps = _peso(i);
            r.total += a.valor;
        }
        for (uint256 i = 0; i < activos.length; i++) {
            if (r.total > 0) r.activos[i].pesoActualBps = (r.activos[i].valor * 10000) / r.total;
        }
        Calculo memory c = _calcular();
        (r.precioUFX, r.ipcAceptado) = (c.precio, c.ipcOk);
        r.ufxEnCirculacion = totalSupply();
        r.deuda = (r.ufxEnCirculacion * r.precioUFX) / 1e18;
        r.colchon = r.total > r.deuda ? r.total - r.deuda : 0;
        r.ratioBps = r.deuda == 0 ? type(uint256).max : (r.total * 10000) / r.deuda;
        r.modoDefensivo = modoDefensivo;
    }

    // ─────────────────────────── UFX ───────────────────────────

    /// ENTRAR: das dólares, se compra la canasta, recibes UFX al precio de hoy.
    function acunar(uint256 usd) external returns (uint256) {
        return acunarPara(usd, msg.sender);
    }

    /// Igual que `acunar`, pero las UFX van a `receptor` (útil para agentes y otros contratos).
    function acunarPara(uint256 usd, address receptor) public nonReentrant alDia returns (uint256 nuevas) {
        nuevas = _acunar(usd, 0, receptor);
    }

    /// SALIR: entregas UFX y recibes su valor en dólares. Si una crisis dejó la reserva
    /// bajo la deuda, todos salen con el mismo descuento.
    function quemar(uint256 cant) external returns (uint256) {
        return quemarPara(cant, msg.sender);
    }

    /// Igual que `quemar`, pero los dólares van a `receptor`.
    function quemarPara(uint256 cant, address receptor) public nonReentrant alDia returns (uint256 usd) {
        usd = _quemar(msg.sender, cant, receptor, 0);
    }

    /// Recibe `usd`, compra la canasta y crea UFX por el valor que REALMENTE se compró: el costo de ejecución
    /// (slippage) lo paga quien entra, no los que ya estaban. Con `exactas` > 0 crea exactamente esas UFX
    /// (si la compra rindió lo suficiente).
    function _acunar(uint256 usd, uint256 exactas, address receptor) internal returns (uint256 nuevas) {
        require(usd > 0, "monto vacio");
        require(abiertoDesde != 0, "fase de arranque: se esta armando el colchon");
        IERC20(address(dolar)).safeTransferFrom(msg.sender, address(this), usd);
        uint256 adquirido = _comprarCanasta(usd);
        nuevas = (adquirido * 1e18) / precioUnidad();
        if (exactas > 0) {
            require(nuevas + TOLERANCIA_REDONDEO >= exactas, "costo de ejecucion: usa deposit");
            nuevas = exactas;
        }
        require(nuevas > 0, "monto vacio");
        _mint(receptor, nuevas);
        require(ratio() >= RATIO_MIN, "respaldo bajo 120%: creacion pausada");
        emit Acunado(msg.sender, receptor, usd, nuevas);
        emit Deposit(msg.sender, receptor, usd, nuevas);
    }

    /// Quema `cant` UFX de `dueno` (con permiso si quien llama es otro) y paga a `receptor`.
    /// Si `usdExacto` > 0 se paga exactamente eso (lo que sobra de redondeo queda en la reserva).
    function _quemar(address dueno, uint256 cant, address receptor, uint256 usdExacto) internal returns (uint256 usd) {
        require(cant > 0 && cant <= balanceOf(dueno), "cantidad invalida");
        if (msg.sender != dueno) _spendAllowance(dueno, msg.sender, cant);
        usd = previewQuemar(cant);
        _burn(dueno, cant);
        usd = _venderCanasta(usd);
        if (usdExacto > 0) {
            require(usd >= usdExacto, "costo de ejecucion: usa redeem");
            usd = usdExacto;
        }
        IERC20(address(dolar)).safeTransfer(receptor, usd);
        emit Quemado(dueno, receptor, cant, usd);
        emit Withdraw(msg.sender, receptor, dueno, usd, cant);
    }

    // ─────────────────────────── ERC-4626 ───────────────────────────
    // Interfaz estándar de bóveda: el activo es el dólar (USDC) y las "acciones" son UFX.
    // Así cualquier agregador o framework de agentes que entienda ERC-4626 puede usar UFX sin código especial.

    uint256 private constant POLVO_RETIRO = 1000; // margen en wei para que un retiro exacto nunca quede corto por redondeo
    uint256 private constant TOLERANCIA_REDONDEO = 1e9; // ~1e-9 UFX: redondeo de la compra repartida en varios activos

    function asset() external view returns (address) {
        return address(dolar);
    }

    /// Dólares que se deben a quienes tienen UFX.
    function totalAssets() external view returns (uint256) {
        return deuda();
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * 1e18) / precioUnidad();
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * precioUnidad()) / 1e18;
    }

    /// Máximo que se puede depositar hoy sin dejar el respaldo bajo 120% (0 durante el arranque).
    function maxDeposit(address) public view returns (uint256) {
        if (abiertoDesde == 0) return 0;
        uint256 r = valorReserva() * 10000;
        uint256 d = deuda() * RATIO_MIN;
        return r > d ? (r - d) / (RATIO_MIN - 10000) : 0;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    /// `previewDeposit` no puede saber el costo de ejecución: lo recibido puede ser un poco menor.
    function deposit(uint256 assets, address receiver) external nonReentrant alDia returns (uint256 shares) {
        shares = _acunar(assets, 0, receiver);
    }

    function maxMint(address receiver) external view returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, precioUnidad(), 1e18, Math.Rounding.Ceil);
    }

    function mint(uint256 shares, address receiver) external nonReentrant alDia returns (uint256 assets) {
        assets = previewMint(shares);
        _acunar(assets, shares, receiver);
    }

    function maxWithdraw(address owner_) external view returns (uint256) {
        uint256 v = previewQuemar(balanceOf(owner_));
        return v > POLVO_RETIRO ? v - POLVO_RETIRO : 0;
    }

    /// UFX que hay que quemar para recibir exactamente `assets` (con descuento si la reserva no alcanza).
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 sup = totalSupply();
        uint256 r = valorReserva();
        uint256 conPolvo = assets + POLVO_RETIRO;
        if (sup > 0 && r < deuda()) {
            require(r > 0, "reserva vacia");
            return Math.mulDiv(conPolvo, sup, r, Math.Rounding.Ceil);
        }
        return Math.mulDiv(conPolvo, 1e18, precioUnidad(), Math.Rounding.Ceil);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external nonReentrant alDia returns (uint256 shares) {
        shares = previewWithdraw(assets);
        _quemar(owner_, shares, receiver, assets);
    }

    function maxRedeem(address owner_) external view returns (uint256) {
        return balanceOf(owner_);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return previewQuemar(shares);
    }

    function redeem(uint256 shares, address receiver, address owner_) external nonReentrant alDia returns (uint256 assets) {
        assets = _quemar(owner_, shares, receiver, 0);
    }

    // ─────────────────────────── colchón ───────────────────────────

    /// Aportar al colchón: absorbes las caídas y te quedas con las ganancias extra.
    function aportarColchon(uint256 usd) external nonReentrant alDia returns (uint256 nuevas) {
        require(usd > 0, "monto vacio");
        // Después del arranque se paga entrada: se compra la canasta con todo, pero las partes son por el neto.
        // Las partes se calculan por lo que REALMENTE se compró (el costo de ejecución lo paga quien entra).
        uint256 netoBps = abiertoDesde == 0 ? 10000 : 10000 - cuotaEntradaBps;
        uint256 total = partesColchonTotal();
        uint256 c = colchon();
        require(total == 0 || c > 0, "colchon agotado");
        desdeColchon[msg.sender] = block.timestamp;
        IERC20(address(dolar)).safeTransferFrom(msg.sender, address(this), usd);
        uint256 adquirido = _comprarCanasta(usd);
        nuevas = total == 0 ? (adquirido * netoBps) / 10000 : (adquirido * netoBps * total) / (10000 * c);
        partes.acunar(msg.sender, nuevas);
        emit ColchonAportado(msg.sender, usd, nuevas);
        if (abiertoDesde == 0 && colchon() >= metaArranque) {
            abiertoDesde = block.timestamp;
            emit UFXAbierta(colchon());
        }
    }

    /// Retirar del colchón: solo si después la reserva sigue sobre 120%.
    /// `cant = type(uint256).max` retira todo (incluida la comisión que se acredite en esta misma operación).
    function retirarColchon(uint256 cant) external nonReentrant alDia returns (uint256 usd) {
        if (cant == type(uint256).max) cant = partes.balanceOf(msg.sender);
        require(cant > 0 && cant <= partes.balanceOf(msg.sender), "partes invalidas");
        usd = (colchon() * cant) / partesColchonTotal();
        if (block.timestamp < desdeColchon[msg.sender] + DURACION_ANIO) {
            usd -= (usd * multaSalidaBps) / 10000; // queda para los que se quedan
        }
        partes.quemar(msg.sender, cant);
        usd = _venderCanasta(usd);
        require(totalSupply() == 0 || ratio() >= RATIO_MIN, "dejaria la reserva bajo 120%");
        IERC20(address(dolar)).safeTransfer(msg.sender, usd);
        emit ColchonRetirado(msg.sender, cant, usd);
    }

    /// Llamado por el token UFXC: quien recibe partes hereda la antigüedad más reciente.
    function registrarTransferenciaColchon(address from, address to) external {
        require(msg.sender == address(partes), "solo UFXC");
        if (desdeColchon[from] > desdeColchon[to]) desdeColchon[to] = desdeColchon[from];
    }

    /// Solo el fundador puede pasar su comisión a otra dirección. No da ningún otro poder.
    function cambiarFundador(address nuevo) external {
        require(msg.sender == fundador, "solo fundador");
        require(nuevo != address(0), "direccion vacia");
        fundador = nuevo;
        emit FundadorCambiado(nuevo);
    }

    // ─────────────────────────── mantención ───────────────────────────

    /// Para bots: actualiza el precio, rebalancea si ya toca y paga una propina en UFXC
    /// (como máximo una vez al día). Cualquiera puede llamarlo.
    function mantener() external nonReentrant alDia returns (uint256 recompensa) {
        bool cambio = _revisarModoDefensivo();
        if (cambio || block.timestamp >= ultimoRebalanceo + rebalanceoCada) _rebalancear();
        if (block.timestamp >= ultimaMantencion + MANTENCION_CADA) {
            ultimaMantencion = block.timestamp;
            recompensa = _pagarEnPartes(msg.sender, recompensaUsd);
        }
        emit Mantenido(msg.sender, recompensa);
    }

    /// Volver a los pesos objetivo ahora mismo (sin propina). Cualquiera puede llamarlo.
    function rebalancear() external nonReentrant alDia {
        _rebalancear();
    }

    // ─────────────────────────── interno ───────────────────────────

    /// Lee el oráculo sin trabarse: si no hay dato (o está viejo) devuelve ok = false.
    function _leer(address clave) internal view returns (bool ok, uint256 v) {
        try oraculo.precio(clave) returns (uint256 x) {
            return (true, x);
        } catch {
            return (false, 0);
        }
    }

    /// ¿El IPC nuevo está dentro del rango razonable desde el último cambio aceptado?
    /// La ventana mínima es de un mes, para que un dato mensual normal siempre pase.
    function _ipcRazonable(uint256 ipc) internal view returns (bool) {
        uint256 ventana = block.timestamp - tIpcCambio;
        if (ventana < 30 days) ventana = 30 days;
        uint256 subida = (ipcGuardado * IPC_SUBIDA_MAX_MES_BPS * ventana) / (10000 * 30 days);
        uint256 bajada = (ipcGuardado * IPC_BAJADA_MAX_MES_BPS * ventana) / (10000 * 30 days);
        if (bajada > ipcGuardado / 2) bajada = ipcGuardado / 2;
        return ipc <= ipcGuardado + subida && ipc + bajada >= ipcGuardado;
    }

    struct Calculo {
        uint256 precio;
        uint256 ipcUsado;
        uint256 tbillUsado;
        bool ipcOk;
        uint256 pataIpc;
        uint256 pataTbill;
    }

    /// Avanza las dos patas desde la última actualización y toma la mayor (sin bajar nunca).
    function _calcular() internal view returns (Calculo memory c) {
        (bool hayIpc, uint256 ipc) = _leer(IPC);
        (bool hayTbill, uint256 tbill) = _leer(TBILL);
        c.tbillUsado = hayTbill ? tbill : tbillGuardado;
        if (tGuardado == 0) {
            require(hayIpc, "sin IPC inicial");
            return Calculo(precioGuardado, ipc, c.tbillUsado, true, pataIpc, pataTbill);
        }
        uint256 dt = block.timestamp - tGuardado;
        c.ipcOk = hayIpc && _ipcRazonable(ipc);
        c.ipcUsado = c.ipcOk ? ipc : ipcGuardado; // sin dato confiable, la inflación espera y se pone al día después
        uint256 real = 1e18 + (tasaFijaBps * 1e14 * dt) / DURACION_ANIO;
        c.pataIpc = (((pataIpc * c.ipcUsado) / ipcGuardado) * real) / 1e18;
        c.pataTbill = pisoStable
            ? (pataTbill * (1e18 + ((c.tbillUsado + margenBps * 1e14) * dt) / DURACION_ANIO)) / 1e18
            : 0;
        c.precio = precioGuardado;
        if (c.pataIpc > c.precio) c.precio = c.pataIpc;
        if (c.pataTbill > c.precio) c.precio = c.pataTbill;
    }

    function _actualizarPrecio() internal {
        Calculo memory c = _calcular();
        if (!c.ipcOk && tGuardado != 0) {
            (bool hayIpc, uint256 ipc) = _leer(IPC);
            emit IPCIgnorado(ipc, !hayIpc);
        }
        if (c.ipcUsado != ipcGuardado) tIpcCambio = block.timestamp;
        (precioGuardado, ipcGuardado, tbillGuardado, tGuardado) = (c.precio, c.ipcUsado, c.tbillUsado, block.timestamp);
        (pataIpc, pataTbill) = (c.pataIpc, c.pataTbill);
    }

    /// Entra al modo defensivo bajo el umbral y sale 10 puntos más arriba. Devuelve true si cambió.
    function _revisarModoDefensivo() internal returns (bool) {
        if (umbralDefensivoBps == 0 || totalSupply() == 0) return false;
        uint256 r = ratio();
        bool deberia = modoDefensivo ? r < umbralDefensivoBps + SALIDA_DEFENSIVO_BPS : r < umbralDefensivoBps;
        if (deberia == modoDefensivo) return false;
        modoDefensivo = deberia;
        emit ModoDefensivo(deberia, r);
        return true;
    }

    function _peso(uint256 i) internal view returns (uint256) {
        return modoDefensivo ? pesosDefensivosBps[i] : pesosBps[i];
    }

    /// Comisión del fundador acumulada desde la última vez. El primer año después de abrir es gratis.
    function _cobrarComision() internal {
        uint256 desde = tComision;
        tComision = block.timestamp;
        if (desde == 0 || comisionBps == 0 || abiertoDesde == 0) return;
        uint256 gratisHasta = abiertoDesde + DURACION_ANIO;
        if (block.timestamp <= gratisHasta) return;
        if (desde < gratisHasta) desde = gratisHasta;
        uint256 usd = (valorReserva() * comisionBps * (block.timestamp - desde)) / (10000 * DURACION_ANIO);
        uint256 p = _pagarEnPartes(fundador, usd);
        if (p > 0) emit ComisionFundador(usd, p);
    }

    /// Paga `usd` a `a` en partes nuevas del colchón (diluye al colchón, nunca a UFX).
    function _pagarEnPartes(address a, uint256 usd) internal returns (uint256 nuevas) {
        uint256 total = partesColchonTotal();
        uint256 c = colchon();
        if (usd == 0 || total == 0 || usd >= c) return 0;
        nuevas = (usd * total) / (c - usd); // así esas partes valen exactamente `usd`
        partes.acunar(a, nuevas);
    }

    function _rebalancear() internal {
        ultimoRebalanceo = block.timestamp;
        uint256 total = valorReserva();
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 p = oraculo.precio(address(activos[i]));
            uint256 valor = (activos[i].balanceOf(address(this)) * p) / 1e18;
            uint256 objetivo = (total * _peso(i)) / 10000;
            if (valor > objetivo) mercado.vender(activos[i], ((valor - objetivo) * 1e18) / p);
        }
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 p = oraculo.precio(address(activos[i]));
            uint256 valor = (activos[i].balanceOf(address(this)) * p) / 1e18;
            uint256 objetivo = (total * _peso(i)) / 10000;
            if (valor < objetivo) {
                uint256 falta = objetivo - valor;
                uint256 caja = dolar.balanceOf(address(this));
                mercado.comprar(activos[i], falta < caja ? falta : caja);
            }
        }
        emit Rebalanceado(total);
    }

    /// Compra la canasta con `usd` y devuelve el valor (al precio del oráculo) que realmente quedó en la reserva:
    /// lo comprado más los restos de redondeo que quedan en caja.
    function _comprarCanasta(uint256 usd) internal returns (uint256 adquirido) {
        uint256 gastado = 0;
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 monto = (usd * _peso(i)) / 10000;
            uint256 cant = mercado.comprar(activos[i], monto);
            adquirido += (cant * oraculo.precio(address(activos[i]))) / 1e18;
            gastado += monto;
        }
        adquirido += usd - gastado;
    }

    /// Vende una tajada pareja de cada activo para juntar `usd`. Devuelve lo que se juntó.
    function _venderCanasta(uint256 usd) internal returns (uint256) {
        uint256 total = valorReserva();
        if (usd >= total) usd = total;
        uint256 caja = dolar.balanceOf(address(this));
        if (usd > caja) {
            uint256 falta = usd - caja;
            uint256 enActivos = total - caja;
            for (uint256 i = 0; i < activos.length; i++) {
                uint256 parte = (activos[i].balanceOf(address(this)) * falta) / enActivos;
                if (parte > 0) mercado.vender(activos[i], parte);
            }
        }
        caja = dolar.balanceOf(address(this));
        return usd < caja ? usd : caja;
    }
}
