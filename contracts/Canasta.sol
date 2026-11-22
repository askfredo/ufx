// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ════════════════════════════════════════════════════════════════════
//  PIEZAS DE PRUEBA (en la vida real serían PAXG, SPYon, USDY, WTIC, USDC,
//  un oráculo como Chainlink y un exchange real)
// ════════════════════════════════════════════════════════════════════

/// Token de prueba: sirve para el dólar y para cada activo tokenizado.
contract TokenPrueba is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function regalar(address a, uint256 m) external { _mint(a, m); } // solo para pruebas
}

/// Oráculo: dice cuántos dólares vale cada activo. Rechaza precios viejos.
contract OraculoPrueba {
    struct Precio { uint256 usd; uint256 fecha; }
    address public immutable dueno;
    mapping(address => Precio) public precios;

    constructor() { dueno = msg.sender; }

    function fijarPrecio(address activo, uint256 usd) external {
        require(msg.sender == dueno, "solo dueno");
        precios[activo] = Precio(usd, block.timestamp);
    }

    function precio(address activo) external view returns (uint256) {
        Precio memory p = precios[activo];
        require(p.usd > 0, "sin precio");
        require(block.timestamp - p.fecha <= 2 days, "precio viejo"); // seguridad básica
        return p.usd;
    }
}

/// Mercado: compra y vende cualquier activo al precio del oráculo.
contract MercadoPrueba {
    OraculoPrueba public immutable oraculo;
    TokenPrueba public immutable dolar;

    constructor(OraculoPrueba o, TokenPrueba d) { oraculo = o; dolar = d; }

    function comprar(TokenPrueba activo, uint256 usd) external returns (uint256 cant) {
        dolar.transferFrom(msg.sender, address(this), usd);
        cant = (usd * 1e18) / oraculo.precio(address(activo));
        activo.regalar(msg.sender, cant);
    }

    function vender(TokenPrueba activo, uint256 cant) external returns (uint256 usd) {
        activo.transferFrom(msg.sender, address(this), cant);
        usd = (cant * oraculo.precio(address(activo))) / 1e18;
        dolar.regalar(msg.sender, usd);
    }
}

// ════════════════════════════════════════════════════════════════════
//  TU MONEDA: UFX ("UF global")
//  - Se CREA solo cuando alguien entra con dólares (que se usan para comprar la canasta).
//  - Se QUEMA cuando alguien sale (se vende su parte de la canasta y recibe dólares).
//  - Su precio = valor de la canasta / monedas que existen. Nadie lo fija a mano.
// ════════════════════════════════════════════════════════════════════
contract MonedaCanasta is ERC20, ReentrancyGuard {
    TokenPrueba public immutable dolar;
    MercadoPrueba public immutable mercado;
    OraculoPrueba public immutable oraculo;

    TokenPrueba[] public activos;
    uint256[] public pesosBps; // 3500 = 35% de la canasta

    event Acunado(address indexed quien, uint256 dolares, uint256 monedas);
    event Quemado(address indexed quien, uint256 monedas, uint256 dolares);
    event Rebalanceado(uint256 valorTotal);

    constructor(
        TokenPrueba _dolar,
        MercadoPrueba _mercado,
        OraculoPrueba _oraculo,
        TokenPrueba[] memory _activos,
        uint256[] memory _pesos
    ) ERC20("UF Global", "UFX") {
        require(_activos.length == _pesos.length, "largos distintos");
        uint256 suma;
        for (uint256 i = 0; i < _pesos.length; i++) suma += _pesos[i];
        require(suma == 10000, "los pesos deben sumar 100%");

        dolar = _dolar;
        mercado = _mercado;
        oraculo = _oraculo;
        activos = _activos;
        pesosBps = _pesos;

        dolar.approve(address(_mercado), type(uint256).max);
        for (uint256 i = 0; i < _activos.length; i++) _activos[i].approve(address(_mercado), type(uint256).max);
    }

    /// Dólares que vale todo lo que hay en la reserva.
    function valorReserva() public view returns (uint256 total) {
        total = dolar.balanceOf(address(this)); // restos de redondeo
        for (uint256 i = 0; i < activos.length; i++) {
            total += (activos[i].balanceOf(address(this)) * oraculo.precio(address(activos[i]))) / 1e18;
        }
    }

    /// Cuántos dólares vale 1 UFX. Parte en $1.
    function precioUnidad() public view returns (uint256) {
        uint256 s = totalSupply();
        return s == 0 ? 1e18 : (valorReserva() * 1e18) / s;
    }

    /// ENTRAR: das dólares, se compra la canasta, se crean UFX nuevas.
    function acunar(uint256 usd) external nonReentrant returns (uint256 nuevas) {
        require(usd > 0, "monto vacio");
        uint256 precioAntes = precioUnidad();
        dolar.transferFrom(msg.sender, address(this), usd);
        for (uint256 i = 0; i < activos.length; i++) {
            mercado.comprar(activos[i], (usd * pesosBps[i]) / 10000);
        }
        nuevas = (usd * 1e18) / precioAntes;
        _mint(msg.sender, nuevas);
        emit Acunado(msg.sender, usd, nuevas);
    }

    /// SALIR: entregas UFX, se queman, se vende tu parte de la canasta y recibes dólares.
    function quemar(uint256 cant) external nonReentrant returns (uint256 usd) {
        require(cant > 0 && cant <= balanceOf(msg.sender), "cantidad invalida");
        uint256 s = totalSupply();
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 parte = (activos[i].balanceOf(address(this)) * cant) / s;
            if (parte > 0) usd += mercado.vender(activos[i], parte);
        }
        usd += (dolar.balanceOf(address(this)) - usd) * cant / s; // su parte de los restos
        _burn(msg.sender, cant);
        dolar.transfer(msg.sender, usd);
        emit Quemado(msg.sender, cant, usd);
    }

    /// Volver a los pesos objetivo: vende lo que subió mucho, compra lo que bajó.
    /// (Comprar barato y vender caro de forma automática.) Cualquiera puede llamarlo.
    function rebalancear() external nonReentrant {
        uint256 total = valorReserva();
        // 1) vender lo que sobra
        for (uint256 i = 0; i < activos.length; i++) {
            uint256 p = oraculo.precio(address(activos[i]));
            uint256 valor = (activos[i].balanceOf(address(this)) * p) / 1e18;
            uint256 objetivo = (total * pesosBps[i]) / 10000;
            if (valor > objetivo) mercado.vender(activos[i], ((valor - objetivo) * 1e18) / p);
        }
        // 2) comprar lo que falta
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
}
