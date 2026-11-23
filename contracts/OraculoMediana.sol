// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Canasta.sol"; // IOraculo

/// Oráculo sin dueño: para cada clave (precio de un activo, IPC, tasa de T-bills) devuelve la MEDIANA de
/// varias fuentes independientes. Las fuentes sin dato o con dato viejo se ignoran, y hacen falta al menos
/// `minFuentes` fuentes válidas. Una sola fuente equivocada o manipulada no mueve el resultado.
/// Las fuentes quedan fijas al desplegar: nadie puede agregarlas ni cambiarlas después.
contract OraculoMediana is IOraculo {
    IOraculo[] public fuentes;
    uint256 public immutable minFuentes;

    constructor(IOraculo[] memory _fuentes, uint256 _minFuentes) {
        require(_minFuentes > 0 && _minFuentes <= _fuentes.length, "minimo de fuentes invalido");
        for (uint256 i = 0; i < _fuentes.length; i++) fuentes.push(_fuentes[i]);
        minFuentes = _minFuentes;
    }

    function cantidadFuentes() external view returns (uint256) {
        return fuentes.length;
    }

    function precio(address clave) external view returns (uint256) {
        uint256[] memory v = new uint256[](fuentes.length);
        uint256 n = 0;
        for (uint256 i = 0; i < fuentes.length; i++) {
            try fuentes[i].precio(clave) returns (uint256 x) {
                v[n++] = x;
            } catch {}
        }
        require(n >= minFuentes, "pocas fuentes validas");
        for (uint256 i = 1; i < n; i++) { // ordenamiento por inserción (pocas fuentes)
            uint256 x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > x) {
                v[j] = v[j - 1];
                j--;
            }
            v[j] = x;
        }
        return n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
}
