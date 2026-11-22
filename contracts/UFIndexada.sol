// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Canasta.sol"; // TokenPrueba, OraculoPrueba, MercadoPrueba

// ════════════════════════════════════════════════════════════════════
//  UFX: "UF Global", una unidad de ahorro para personas y agentes de IA.
//  - 1 UFX = $1 al comienzo. Su precio sube lo que sea MAYOR entre
//        inflación + tasa fija   (como un depósito en "UF + x%")
//        T-bills + margen        (para ganarle siempre a las stablecoins)
//    y nunca baja. UFX es un ERC-20 normal: se transfiere barato y sin sorpresas.
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

contract UFIndexada is ERC20, ReentrancyGuard {
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
    }

    /// Clave del oráculo para el índice de precios (1e18 = $1 al inicio).
    address public constant IPC = address(uint160(uint256(keccak256("IPC global"))));
    /// Clave del oráculo para la tasa anual de los T-bills (1e18 = 100%).
    address public constant TBILL = address(uint160(uint256(keccak256("Tasa T-bill"))));
    uint256 public constant RATIO_MIN = 12000; // 120%
    uint256 public constant DURACION_ANIO = 31557600; // 365,25 días
    uint256 public constant MANTENCION_CADA = 1 days;

    TokenPrueba public immutable dolar;
    MercadoPrueba public immutable mercado;
    OraculoPrueba public immutable oraculo;
    ParteColchon public immutable partes;

    TokenPrueba[] public activos;
    uint256[] public pesosBps;

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

    event Acunado(address indexed quien, address indexed receptor, uint256 dolares, uint256 monedas);
    event Quemado(address indexed quien, address indexed receptor, uint256 monedas, uint256 dolares);
    event ColchonAportado(address indexed quien, uint256 dolares, uint256 partes);
    event ColchonRetirado(address indexed quien, uint256 partes, uint256 dolares);
    event Rebalanceado(uint256 valorTotal);
    event Mantenido(address indexed bot, uint256 recompensaPartes);
    event ComisionFundador(uint256 dolares, uint256 partes);
    event FundadorCambiado(address nuevo);
    event UFXAbierta(uint256 colchon);

    /// Antes de cualquier movimiento: guardar el precio de hoy y cobrar la comisión que toque.
    modifier alDia() {
        _actualizarPrecio();
        _cobrarComision();
        _;
    }

    constructor(
        TokenPrueba _dolar,
        MercadoPrueba _mercado,
        OraculoPrueba _oraculo,
        TokenPrueba[] memory _activos,
        uint256[] memory _pesos,
        Config memory c
    ) ERC20("UF Global", "UFX") {
        require(_activos.length == _pesos.length, "largos distintos");
        uint256 suma = 0;
        for (uint256 i = 0; i < _pesos.length; i++) suma += _pesos[i];
        require(suma == 10000, "los pesos deben sumar 100%");
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
        ultimoRebalanceo = block.timestamp;

        IERC20(address(dolar)).forceApprove(address(_mercado), type(uint256).max);
        for (uint256 i = 0; i < _activos.length; i++) IERC20(address(_activos[i])).forceApprove(address(_mercado), type(uint256).max);
    }

    // ─────────────────────────── lecturas ───────────────────────────

    /// Dólares que vale 1 UFX. Parte en $1 y nunca baja.
    function precioUnidad() public view returns (uint256 p) {
        (p, ) = _precioAhora();
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

    // ─────────────────────────── UFX ───────────────────────────

    /// ENTRAR: das dólares, se compra la canasta, recibes UFX al precio de hoy.
    function acunar(uint256 usd) external returns (uint256) {
        return acunarPara(usd, msg.sender);
    }

    /// Igual que `acunar`, pero las UFX van a `receptor` (útil para agentes y otros contratos).
    function acunarPara(uint256 usd, address receptor) public nonReentrant alDia returns (uint256 nuevas) {
        require(usd > 0, "monto vacio");
        require(abiertoDesde != 0, "fase de arranque: se esta armando el colchon");
        nuevas = (usd * 1e18) / precioUnidad();
        IERC20(address(dolar)).safeTransferFrom(msg.sender, address(this), usd);
        _comprarCanasta(usd);
        _mint(receptor, nuevas);
        require(ratio() >= RATIO_MIN, "respaldo bajo 120%: creacion pausada");
        emit Acunado(msg.sender, receptor, usd, nuevas);
    }

    /// SALIR: entregas UFX y recibes su valor en dólares. Si una crisis dejó la reserva
    /// bajo la deuda, todos salen con el mismo descuento.
    function quemar(uint256 cant) external returns (uint256) {
        return quemarPara(cant, msg.sender);
    }

    /// Igual que `quemar`, pero los dólares van a `receptor`.
    function quemarPara(uint256 cant, address receptor) public nonReentrant alDia returns (uint256 usd) {
        require(cant > 0 && cant <= balanceOf(msg.sender), "cantidad invalida");
        usd = previewQuemar(cant);
        _burn(msg.sender, cant);
        usd = _venderCanasta(usd);
        IERC20(address(dolar)).safeTransfer(receptor, usd);
        emit Quemado(msg.sender, receptor, cant, usd);
    }

    // ─────────────────────────── colchón ───────────────────────────

    /// Aportar al colchón: absorbes las caídas y te quedas con las ganancias extra.
    function aportarColchon(uint256 usd) external nonReentrant alDia returns (uint256 nuevas) {
        require(usd > 0, "monto vacio");
        // Después del arranque se paga entrada: se compra la canasta con todo, pero las partes son por el neto.
        uint256 netoBps = abiertoDesde == 0 ? 10000 : 10000 - cuotaEntradaBps;
        uint256 total = partesColchonTotal();
        if (total == 0) {
            nuevas = (usd * netoBps) / 10000;
        } else {
            uint256 c = colchon();
            require(c > 0, "colchon agotado");
            nuevas = (usd * netoBps * total) / (10000 * c);
        }
        desdeColchon[msg.sender] = block.timestamp;
        IERC20(address(dolar)).safeTransferFrom(msg.sender, address(this), usd);
        _comprarCanasta(usd);
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
        if (block.timestamp >= ultimoRebalanceo + rebalanceoCada) _rebalancear();
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

    /// Precio guardado × lo que haya que sumarle desde la última actualización.
    function _precioAhora() internal view returns (uint256 p, uint256 ipc) {
        ipc = oraculo.precio(IPC);
        if (tGuardado == 0) return (precioGuardado, ipc);
        uint256 dt = block.timestamp - tGuardado;
        uint256 crecer = (ipc * (1e18 + (tasaFijaBps * 1e14 * dt) / DURACION_ANIO)) / ipcGuardado;
        if (pisoStable) {
            uint256 porStable = 1e18 + ((oraculo.precio(TBILL) + margenBps * 1e14) * dt) / DURACION_ANIO;
            if (porStable > crecer) crecer = porStable;
        }
        p = (precioGuardado * crecer) / 1e18;
    }

    function _actualizarPrecio() internal {
        (uint256 p, uint256 ipc) = _precioAhora();
        (precioGuardado, ipcGuardado, tGuardado) = (p, ipc, block.timestamp);
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
            uint256 objetivo = (total * pesosBps[i]) / 10000;
            if (valor > objetivo) mercado.vender(activos[i], ((valor - objetivo) * 1e18) / p);
        }
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 p = oraculo.precio(address(activos[i]));
            uint256 valor = (activos[i].balanceOf(address(this)) * p) / 1e18;
            uint256 objetivo = (total * pesosBps[i]) / 10000;
            if (valor < objetivo) {
                uint256 falta = objetivo - valor;
                uint256 caja = dolar.balanceOf(address(this));
                mercado.comprar(activos[i], falta < caja ? falta : caja);
            }
        }
        emit Rebalanceado(total);
    }

    function _comprarCanasta(uint256 usd) internal {
        for (uint256 i = 0; i < activos.length; i++) {
            mercado.comprar(activos[i], (usd * pesosBps[i]) / 10000);
        }
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
