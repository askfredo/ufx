// Pruebas de UFX (UFIndexada) con tokens de mentira.
// Ejecutar:  npx hardhat test
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const e18 = (n) => ethers.parseUnits(Number(n).toFixed(12), 18);
const num = (x) => Number(ethers.formatUnits(x, 18));
const ANIO = 31557600;
const DIA = 86400;

async function desplegar(opciones = {}) {
  const o = {
    tasaBps: 200, piso: true, margenBps: 50, comisionBps: 10, meta: 1000, cuotaBps: 200, multaBps: 100,
    recompensa: 0, rebalanceoCada: 100 * ANIO, umbral: 0, pesosDefensivos: [], ...opciones,
  };
  const [dueno, fondo, ana, beto, fundador, otro] = await ethers.getSigners();
  const T = await ethers.getContractFactory("TokenPrueba");
  const dolar = await T.deploy("Dolar", "USD");
  const activos = [await T.deploy("Acciones", "tACC"), await T.deploy("Bonos", "tBONO"), await T.deploy("Oro", "tORO")];
  const pesos = [4000, 4000, 2000];
  const oraculo = await (await ethers.getContractFactory("OraculoPrueba")).deploy();
  const mercado = await (await ethers.getContractFactory("MercadoPrueba")).deploy(oraculo, dolar);
  const ufx = await (await ethers.getContractFactory("UFIndexada")).deploy(dolar, mercado, oraculo, activos, pesos, o.pesosDefensivos, {
    tasaFijaBps: o.tasaBps, pisoStable: o.piso, margenBps: o.margenBps, fundador: fundador.address,
    comisionBps: o.comisionBps, metaArranque: e18(o.meta), cuotaEntradaBps: o.cuotaBps, multaSalidaBps: o.multaBps,
    recompensaUsd: e18(o.recompensa), rebalanceoCada: o.rebalanceoCada, umbralDefensivoBps: o.umbral,
  });
  const ufxc = await ethers.getContractAt("ParteColchon", await ufx.partes());
  const IPC = await ufx.IPC();
  const TBILL = await ufx.TBILL();

  const estado = { ipc: 1, tbill: 0.04, precios: [100, 100, 100] };
  const publicar = async (cambios = {}) => {
    Object.assign(estado, cambios);
    for (let i = 0; i < activos.length; i++) await oraculo.fijarPrecio(activos[i], e18(estado.precios[i]));
    await oraculo.fijarPrecio(IPC, e18(estado.ipc));
    await oraculo.fijarPrecio(TBILL, e18(estado.tbill) + 1n);
  };
  const avanzar = async (segundos, cambios = {}) => {
    await time.increase(segundos);
    await publicar(cambios);
  };
  const dar = async (quien, n) => {
    await dolar.regalar(quien.address, e18(n));
    await dolar.connect(quien).approve(ufx, ethers.MaxUint256);
  };
  const colchonDe = async (quien) => {
    const total = await ufx.partesColchonTotal();
    return total === 0n ? 0 : num(await ufx.colchon()) * Number(await ufx.partesColchon(quien.address)) / Number(total);
  };
  await publicar();
  return { dueno, fondo, ana, beto, fundador, otro, dolar, activos, pesos, oraculo, mercado, ufx, ufxc, publicar, avanzar, dar, colchonDe, estado };
}

// Colchón de $1.000 (abre UFX) y Ana con $4.000 en UFX: respaldo 125%.
async function abierto(opciones) {
  const f = await desplegar(opciones);
  await f.dar(f.fondo, 1000);
  await f.ufx.connect(f.fondo).aportarColchon(e18(1000));
  await f.dar(f.ana, 4000);
  await f.ufx.connect(f.ana).acunar(e18(4000));
  return f;
}

describe("UFX", function () {
  describe("Fase de arranque", function () {
    it("no deja crear UFX hasta que el colchón llega a la meta", async function () {
      const { ufx, fondo, ana, dar } = await loadFixture(desplegar);
      await dar(ana, 100);
      await expect(ufx.connect(ana).acunar(e18(100))).to.be.revertedWith("fase de arranque: se esta armando el colchon");
      await dar(fondo, 1000);
      await ufx.connect(fondo).aportarColchon(e18(600));
      expect(await ufx.abiertoDesde()).to.equal(0n);
      await expect(ufx.connect(fondo).aportarColchon(e18(400))).to.emit(ufx, "UFXAbierta");
      await ufx.connect(ana).acunar(e18(100));
      expect(num(await ufx.balanceOf(ana.address))).to.be.closeTo(100, 1e-4); // el precio ya subió unos segundos de interés
    });

    it("los que entran al colchón después pagan entrada que queda para los primeros", async function () {
      const { ufx, fondo, beto, dar, colchonDe } = await loadFixture(desplegar);
      await dar(fondo, 1000);
      await ufx.connect(fondo).aportarColchon(e18(1000));
      await dar(beto, 1000);
      await ufx.connect(beto).aportarColchon(e18(1000));
      // Beto recibe partes por $980; los $20 quedan repartidos en el colchón.
      expect(await colchonDe(beto)).to.be.closeTo(2000 * 980 / 1980, 1e-6);
      expect(await colchonDe(fondo)).to.be.closeTo(2000 * 1000 / 1980, 1e-6);
      expect(await colchonDe(fondo)).to.be.greaterThan(1000);
    });

    it("quien sale del colchón antes de un año deja 1%", async function () {
      const { ufx, fondo, beto, dolar, dar, avanzar } = await loadFixture(desplegar);
      await dar(fondo, 1000);
      await ufx.connect(fondo).aportarColchon(e18(1000));
      await dar(beto, 1000);
      await ufx.connect(beto).aportarColchon(e18(1000));
      await avanzar(30 * DIA);
      const valor = num(await ufx.colchon()) * Number(await ufx.partesColchon(beto.address)) / Number(await ufx.partesColchonTotal());
      const antes = num(await dolar.balanceOf(beto.address));
      await ufx.connect(beto).retirarColchon(await ufx.partesColchon(beto.address));
      expect(num(await dolar.balanceOf(beto.address)) - antes).to.be.closeTo(valor * 0.99, 0.01);
    });

    it("después de un año sale sin multa", async function () {
      const { ufx, fondo, dolar, dar, avanzar } = await loadFixture(desplegar);
      await dar(fondo, 1000);
      await ufx.connect(fondo).aportarColchon(e18(1000));
      await avanzar(ANIO + DIA);
      await ufx.connect(fondo).retirarColchon(await ufx.partesColchon(fondo.address));
      expect(num(await dolar.balanceOf(fondo.address))).to.be.closeTo(1000, 0.01);
    });
  });

  describe("Precio de UFX", function () {
    it("parte en $1", async function () {
      const { ufx } = await loadFixture(abierto);
      expect(num(await ufx.precioUnidad())).to.be.closeTo(1, 1e-6);
    });

    it("sube inflación + 2% cuando eso es más que T-bills + 0,5%", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO, { ipc: 1.05, tbill: 0.03 });
      expect(num(await ufx.precioUnidad())).to.be.closeTo(1.05 * 1.02, 2e-4);
    });

    it("sube T-bills + 0,5% cuando eso es más que inflación + 2%", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO, { ipc: 1.01, tbill: 0.05 });
      expect(num(await ufx.precioUnidad())).to.be.closeTo(1.055, 2e-4);
    });

    it("no baja aunque haya deflación", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO, { ipc: 0.97, tbill: 0.001 });
      expect(num(await ufx.precioUnidad())).to.be.greaterThan(1);
    });

    it("se acumula: dos años de inflación 3% dan ~(1,03 × 1,02)²", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO, { ipc: 1.03, tbill: 0.01 });
      await ufx.mantener(); // guarda el precio
      await avanzar(ANIO, { ipc: 1.03 * 1.03 });
      expect(num(await ufx.precioUnidad())).to.be.closeTo(Math.pow(1.03 * 1.02, 2), 5e-4);
    });
  });

  describe("Colchón y respaldo", function () {
    it("el colchón absorbe una caída y el ahorrador recibe su valor completo", async function () {
      const { ufx, ana, dolar, publicar } = await loadFixture(abierto);
      await publicar({ precios: [85, 85, 85] }); // canasta -15%: reserva 4.250 > deuda 4.000
      const precio = num(await ufx.precioUnidad());
      await ufx.connect(ana).quemar(await ufx.balanceOf(ana.address));
      expect(num(await dolar.balanceOf(ana.address))).to.be.closeTo(4000 * precio, 0.01);
    });

    it("si la reserva queda bajo la deuda, todos salen con el mismo descuento", async function () {
      const { ufx, fondo, ana, beto, dolar, dar, publicar } = await loadFixture(abierto);
      await dar(fondo, 500);
      await ufx.connect(fondo).aportarColchon(e18(500));
      await dar(beto, 1000);
      await ufx.connect(beto).acunar(e18(1000)); // reserva ~6.500, deuda ~5.000
      const reserva = num(await ufx.valorReserva()) * 0.5;
      await publicar({ precios: [50, 50, 50] });  // reserva ~3.250 < deuda ~5.000
      await ufx.connect(ana).quemar(await ufx.balanceOf(ana.address));
      await ufx.connect(beto).quemar(await ufx.balanceOf(beto.address));
      expect(num(await dolar.balanceOf(ana.address))).to.be.closeTo(reserva * 4 / 5, 0.05);
      expect(num(await dolar.balanceOf(beto.address))).to.be.closeTo(reserva * 1 / 5, 0.05);
    });

    it("pausa la creación si el respaldo quedaría bajo 120%", async function () {
      const { ufx, beto, dar } = await loadFixture(abierto);
      await dar(beto, 900);
      // reserva 5.900 / deuda 4.900 ≈ 120,4%: pasa
      await ufx.connect(beto).acunar(e18(900));
      await expect(ufx.connect(beto).acunar(e18(0))).to.be.revertedWith("monto vacio");
      await dar(beto, 200);
      await expect(ufx.connect(beto).acunar(e18(200))).to.be.revertedWith("respaldo bajo 120%: creacion pausada");
    });

    it("no deja sacar colchón si el respaldo queda bajo 120%", async function () {
      const { ufx, fondo, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO + DIA);
      await expect(ufx.connect(fondo).retirarColchon(await ufx.partesColchon(fondo.address)))
        .to.be.revertedWith("dejaria la reserva bajo 120%");
    });

    it("salir de UFX siempre se puede, incluso en crisis", async function () {
      const { ufx, ana, publicar } = await loadFixture(abierto);
      await publicar({ precios: [20, 20, 20] });
      await expect(ufx.connect(ana).quemar(await ufx.balanceOf(ana.address))).to.not.be.reverted;
    });

    it("rechaza quemar más de lo que tienes", async function () {
      const { ufx, ana } = await loadFixture(abierto);
      await expect(ufx.connect(ana).quemar((await ufx.balanceOf(ana.address)) + 1n)).to.be.revertedWith("cantidad invalida");
    });
  });

  describe("Rebalanceo", function () {
    it("vuelve a los pesos objetivo", async function () {
      const { ufx, activos, pesos, oraculo, avanzar } = await loadFixture(abierto);
      await avanzar(30 * DIA, { precios: [200, 100, 80] });
      await ufx.rebalancear();
      const total = num(await ufx.valorReserva());
      for (let i = 0; i < activos.length; i++) {
        const v = num(await activos[i].balanceOf(ufx)) * num(await oraculo.precio(activos[i]));
        expect(v / total).to.be.closeTo(pesos[i] / 10000, 1e-6);
      }
    });
  });

  describe("Comisión del fundador", function () {
    it("no cobra el primer año después de abrir, y después sí", async function () {
      const { ufx, fundador, avanzar, colchonDe } = await loadFixture(abierto);
      await avanzar(180 * DIA);
      await ufx.mantener();
      expect(await ufx.partesColchon(fundador.address)).to.equal(0n);
      await avanzar(ANIO);
      await ufx.mantener();
      await avanzar(180 * DIA);
      await ufx.mantener();
      const reserva = num(await ufx.valorReserva());
      const f = await colchonDe(fundador);
      expect(f).to.be.greaterThan(0);
      expect(f).to.be.lessThan(reserva * 0.001 * 1.1); // ~0,1% por ~medio año cobrado
    });

    it("si nadie usa el contrato durante el primer año, igual no se cobra ese año", async function () {
      const { ufx, fundador, avanzar, colchonDe } = await loadFixture(abierto);
      await avanzar(ANIO + 30 * DIA); // ninguna operación en todo el año gratis
      await ufx.mantener();
      const reserva = num(await ufx.valorReserva());
      // solo ~30 días cobrados, no el año completo
      expect(await colchonDe(fundador)).to.be.closeTo(reserva * 0.001 * 30 / 365.25, reserva * 0.00002);
    });

    it("la comisión la paga el colchón: el ahorrador recibe lo mismo", async function () {
      const conComision = await abierto();
      const sinComision = await desplegar({ comisionBps: 0 });
      await sinComision.dar(sinComision.fondo, 1000);
      await sinComision.ufx.connect(sinComision.fondo).aportarColchon(e18(1000));
      await sinComision.dar(sinComision.ana, 4000);
      await sinComision.ufx.connect(sinComision.ana).acunar(e18(4000));
      await time.increase(2 * ANIO);
      for (const f of [conComision, sinComision]) await f.publicar({ ipc: 1.06, precios: [130, 110, 120] });
      expect(num(await conComision.ufx.precioUnidad())).to.be.closeTo(num(await sinComision.ufx.precioUnidad()), 1e-3);
    });

    it("solo el fundador puede cambiar su dirección", async function () {
      const { ufx, fundador, otro } = await loadFixture(abierto);
      await expect(ufx.connect(otro).cambiarFundador(otro.address)).to.be.revertedWith("solo fundador");
      await ufx.connect(fundador).cambiarFundador(otro.address);
      expect(await ufx.fundador()).to.equal(otro.address);
    });
  });

  describe("Oráculo", function () {
    it("rechaza precios viejos (más de 2 días)", async function () {
      const { ufx, ana, dar } = await loadFixture(abierto);
      await time.increase(3 * DIA);
      await dar(ana, 10);
      await expect(ufx.connect(ana).acunar(e18(10))).to.be.revertedWith("precio viejo");
    });

    it("solo el dueño del oráculo de prueba publica precios", async function () {
      const { oraculo, activos, otro } = await loadFixture(desplegar);
      await expect(oraculo.connect(otro).fijarPrecio(activos[0], e18(1))).to.be.revertedWith("solo dueno");
    });
  });

  describe("Colchón como token (UFXC)", function () {
    it("las partes del colchón son un token que se puede transferir", async function () {
      const { ufx, ufxc, fondo, otro } = await loadFixture(abierto);
      expect(await ufxc.symbol()).to.equal("UFXC");
      const mitad = (await ufxc.balanceOf(fondo.address)) / 2n;
      await ufxc.connect(fondo).transfer(otro.address, mitad);
      expect(await ufx.partesColchon(otro.address)).to.equal(mitad);
    });

    it("quien recibe partes hereda la antigüedad: no se esquiva la multa pasándolas a otra dirección", async function () {
      const { ufx, ufxc, beto, otro, dolar, dar, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO + DIA);
      await dar(beto, 1000);
      await ufx.connect(beto).aportarColchon(e18(1000)); // Beto entra recién
      await ufxc.connect(beto).transfer(otro.address, await ufxc.balanceOf(beto.address));
      expect(await ufx.desdeColchon(otro.address)).to.equal(await ufx.desdeColchon(beto.address));
      const valor = num(await ufx.valorParteColchon()) * num(await ufxc.balanceOf(otro.address));
      await ufx.connect(otro).retirarColchon(ethers.MaxUint256);
      expect(num(await dolar.balanceOf(otro.address))).to.be.closeTo(valor * 0.99, 0.05); // pagó la multa
    });

    it("nadie más que UFX puede crear o quemar partes", async function () {
      const { ufxc, otro } = await loadFixture(abierto);
      await expect(ufxc.connect(otro).acunar(otro.address, 1)).to.be.revertedWith("solo UFX");
      await expect(ufxc.connect(otro).quemar(otro.address, 1)).to.be.revertedWith("solo UFX");
    });
  });

  describe("Para agentes", function () {
    it("acunarPara y quemarPara mandan UFX y dólares a otra dirección", async function () {
      const { ufx, dolar, beto, otro, dar } = await loadFixture(abierto);
      await dar(beto, 100);
      await ufx.connect(beto).acunarPara(e18(100), otro.address);
      expect(num(await ufx.balanceOf(otro.address))).to.be.closeTo(100, 1e-3);
      await ufx.connect(otro).quemarPara(await ufx.balanceOf(otro.address), beto.address);
      expect(num(await dolar.balanceOf(beto.address))).to.be.closeTo(100, 1e-3);
    });

    it("previewAcunar y previewQuemar dicen lo que va a pasar", async function () {
      const { ufx, ana, beto, dar } = await loadFixture(abierto);
      const esperado = await ufx.previewAcunar(e18(50));
      await dar(beto, 50);
      await ufx.connect(beto).acunar(e18(50));
      expect(num(await ufx.balanceOf(beto.address))).to.be.closeTo(num(esperado), 1e-6);
      expect(await ufx.previewAcunar(e18(5000))).to.equal(0n); // la dejaría bajo 120%: avisa con 0
      expect(num(await ufx.previewQuemar(await ufx.balanceOf(ana.address)))).to.be.closeTo(num(await ufx.valorEnDolares(ana.address)), 1e-6);
    });

    it("reservaDetalle muestra todo el respaldo en una sola lectura y cuadra con las otras funciones", async function () {
      const { ufx, activos, avanzar } = await loadFixture(abierto);
      await avanzar(DIA, { precios: [110, 100, 90] });
      const r = await ufx.reservaDetalle();
      expect(r.activos.length).to.equal(activos.length);
      expect(r.activos[0].token).to.equal(await activos[0].getAddress());
      const suma = r.activos.reduce((s, a) => s + a.valor, r.caja);
      expect(suma).to.equal(r.total);
      expect(r.total).to.equal(await ufx.valorReserva());
      expect(num(r.deuda)).to.be.closeTo(num(await ufx.deuda()), 1e-9);
      expect(r.ratioBps).to.equal(await ufx.ratio());
      expect(r.activos.reduce((s, a) => s + a.pesoObjetivoBps, 0n)).to.equal(10000n);
      expect(r.ipcAceptado).to.equal(true);
    });

    it("UFX se transfiere como un ERC-20 normal y su valor viaja con el saldo", async function () {
      const { ufx, ana, otro } = await loadFixture(abierto);
      await ufx.connect(ana).transfer(otro.address, e18(1000));
      expect(num(await ufx.valorEnDolares(otro.address))).to.be.closeTo(1000 * num(await ufx.precioUnidad()), 1e-6);
    });
  });

  describe("Estándar ERC-4626", function () {
    it("asset, totalAssets y conversiones", async function () {
      const { ufx, dolar, avanzar } = await loadFixture(abierto);
      expect(await ufx.asset()).to.equal(await dolar.getAddress());
      expect(await ufx.totalAssets()).to.equal(await ufx.deuda());
      await avanzar(ANIO, { ipc: 1.03 });
      const p = num(await ufx.precioUnidad());
      expect(num(await ufx.convertToAssets(e18(100)))).to.be.closeTo(100 * p, 1e-9);
      expect(num(await ufx.convertToShares(e18(100)))).to.be.closeTo(100 / p, 1e-9);
    });

    it("deposit y mint entregan lo que dicen sus preview", async function () {
      const { ufx, beto, otro, dar, avanzar } = await loadFixture(abierto);
      await avanzar(90 * DIA, { ipc: 1.01 });
      await dar(beto, 1000);
      const esperado = await ufx.previewDeposit(e18(100));
      await expect(ufx.connect(beto).deposit(e18(100), otro.address)).to.emit(ufx, "Deposit");
      // la transacción ocurre unos segundos después de la consulta: el precio ya subió un poquito
      expect(num(await ufx.balanceOf(otro.address))).to.be.closeTo(num(esperado), 1e-6);
      const cuesta = await ufx.previewMint(e18(50));
      const antes = await ufx.balanceOf(beto.address);
      await ufx.connect(beto).mint(e18(50), beto.address);
      expect((await ufx.balanceOf(beto.address)) - antes).to.equal(e18(50)); // exactamente las acciones pedidas
      expect(cuesta).to.be.greaterThan(e18(50)); // el precio ya subió sobre $1
    });

    it("withdraw paga exactamente lo pedido y redeem lo que dice previewRedeem", async function () {
      const { ufx, dolar, ana, otro, avanzar } = await loadFixture(abierto);
      await avanzar(180 * DIA, { ipc: 1.02, precios: [104, 101, 102] });
      await ufx.connect(ana).withdraw(e18(250), otro.address, ana.address);
      expect(await dolar.balanceOf(otro.address)).to.equal(e18(250));
      const esperado = await ufx.previewRedeem(e18(100));
      const antes = await dolar.balanceOf(ana.address);
      await expect(ufx.connect(ana).redeem(e18(100), ana.address, ana.address)).to.emit(ufx, "Withdraw");
      expect(num((await dolar.balanceOf(ana.address)) - antes)).to.be.closeTo(num(esperado), 1e-6);
    });

    it("un tercero solo puede retirar con permiso (allowance)", async function () {
      const { ufx, ana, otro } = await loadFixture(abierto);
      await expect(ufx.connect(otro).redeem(e18(10), otro.address, ana.address)).to.be.reverted;
      await ufx.connect(ana).approve(otro.address, e18(10));
      await ufx.connect(otro).redeem(e18(10), otro.address, ana.address);
      expect(await ufx.allowance(ana.address, otro.address)).to.equal(0n);
    });

    it("maxDeposit respeta el 120% y es 0 durante el arranque", async function () {
      const f = await loadFixture(abierto);
      const max = await f.ufx.maxDeposit(f.beto.address);
      await f.dar(f.beto, 10000);
      await f.ufx.connect(f.beto).deposit(max - e18(1), f.beto.address); // justo bajo el máximo pasa
      await expect(f.ufx.connect(f.beto).deposit(e18(10), f.beto.address)).to.be.revertedWith("respaldo bajo 120%: creacion pausada");
      const nuevo = await desplegar();
      expect(await nuevo.ufx.maxDeposit(nuevo.ana.address)).to.equal(0n);
    });

    it("withdraw también funciona con descuento cuando la reserva no alcanza", async function () {
      const { ufx, dolar, ana, publicar } = await loadFixture(abierto);
      await publicar({ precios: [50, 50, 50] }); // reserva ~2.500 < deuda ~4.000
      const max = await ufx.maxWithdraw(ana.address);
      expect(num(max)).to.be.closeTo(2500, 1);
      await ufx.connect(ana).withdraw(e18(1000), ana.address, ana.address);
      expect(await dolar.balanceOf(ana.address)).to.equal(e18(1000));
    });
  });

  describe("Mantención por bots", function () {
    const conPropina = () => abierto({ recompensa: 0.05 });
    const rebalanceoMensual = () => abierto({ rebalanceoCada: 30 * DIA });

    it("paga una propina en UFXC como máximo una vez al día", async function () {
      const { ufx, ufxc, otro, avanzar } = await loadFixture(conPropina);
      const valorBot = async () => num(await ufxc.balanceOf(otro.address)) * num(await ufx.valorParteColchon());
      await ufx.connect(otro).mantener();
      expect(await valorBot()).to.be.closeTo(0.05, 1e-6);
      await ufx.connect(otro).mantener(); // mismo día: sin propina
      expect(await valorBot()).to.be.closeTo(0.05, 1e-6);
      await avanzar(DIA + 1);
      await ufx.connect(otro).mantener();
      expect(await valorBot()).to.be.closeTo(0.10, 1e-4);
    });

    it("rebalancea solo cuando toca", async function () {
      const { ufx, avanzar } = await loadFixture(rebalanceoMensual);
      await avanzar(10 * DIA, { precios: [200, 100, 80] });
      await expect(ufx.mantener()).to.not.emit(ufx, "Rebalanceado");
      await avanzar(25 * DIA);
      await expect(ufx.mantener()).to.emit(ufx, "Rebalanceado");
    });
  });

  describe("Cortacircuito del IPC", function () {
    it("ignora un salto de inflación absurdo y sigue con la pata de T-bills", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(30 * DIA, { ipc: 1.10, tbill: 0.04 }); // +10% en un mes: sospechoso
      expect(await ufx.ipcAceptado()).to.equal(false);
      await expect(ufx.mantener()).to.emit(ufx, "IPCIgnorado");
      // creció solo por T-bills + 0,5% durante ~30 días, no 10%
      expect(num(await ufx.precioUnidad())).to.be.closeTo(1 + 0.045 * 30 / 365.25, 2e-4);
    });

    it("acepta un dato mensual normal", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(30 * DIA, { ipc: 1.008, tbill: 0.01 });
      expect(await ufx.ipcAceptado()).to.equal(true);
    });

    it("si el oráculo de IPC deja de publicar, UFX sigue funcionando", async function () {
      const { ufx, oraculo, activos, ana, dolar, estado, dar } = await loadFixture(abierto);
      await time.increase(5 * DIA);
      // se publican precios y T-bills, pero el IPC queda viejo
      // (precios fijos: `estado` es JS y no se restaura con loadFixture entre pruebas)
      for (let i = 0; i < activos.length; i++) await oraculo.fijarPrecio(activos[i], e18(100));
      await oraculo.fijarPrecio(await ufx.TBILL(), e18(0.04));
      expect(await ufx.ipcAceptado()).to.equal(false);
      await dar(ana, 100);
      await expect(ufx.connect(ana).acunar(e18(100))).to.not.be.reverted;
      await expect(ufx.connect(ana).quemar(e18(50))).to.not.be.reverted;
      expect(num(await ufx.precioUnidad())).to.be.greaterThan(1);
    });

    it("sin trinquete: si el IPC sube y baja por estacionalidad, UFX paga solo inflación neta + 2%", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      for (let m = 0; m < 12; m++) {
        await avanzar(ANIO / 12, { ipc: m % 2 === 0 ? 1.008 : 1.0, tbill: 0 }); // +0,8% y vuelve, cada mes
        await ufx.mantener();
      }
      // inflación neta del año = 0: el precio queda en el último pico (~1,008 × 1,018 ≈ 1,027) porque nunca baja,
      // pero no acumula cada subida como la regla mes a mes (que habría dado ~1,07)
      const p = num(await ufx.precioUnidad());
      expect(p).to.be.closeTo(1.008 * (1 + 0.02 * 11 / 12), 0.002);
      expect(p).to.be.lessThan(1.03);
    });

    it("cuando el IPC vuelve tras un dato rechazado, la inflación se pone al día", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      await avanzar(ANIO / 2, { ipc: 1.20, tbill: 0 }); // +20% en medio año (el máximo aceptado es ~+12%): rechazado
      await ufx.mantener();
      expect(await ufx.ipcAceptado()).to.equal(false);
      await avanzar(ANIO / 2, { ipc: 1.03, tbill: 0 }); // dato normal del año completo
      await ufx.mantener();
      expect(num(await ufx.precioUnidad())).to.be.closeTo(1.03 * 1.02, 0.002);
    });

    it("la deflación fuerte no hace bajar el precio", async function () {
      const { ufx, avanzar } = await loadFixture(abierto);
      const antes = num(await ufx.precioUnidad());
      await avanzar(30 * DIA, { ipc: 0.95, tbill: 0 });
      await ufx.mantener();
      expect(num(await ufx.precioUnidad())).to.be.at.least(antes);
    });
  });

  describe("Modo defensivo", function () {
    const defensivo = () => abierto({ umbral: 11500, pesosDefensivos: [1000, 6000, 3000] });

    it("con el respaldo bajo el umbral pasa a pesos defensivos, y vuelve cuando se recupera", async function () {
      const { ufx, activos, oraculo, avanzar } = await loadFixture(defensivo);
      const pesoAcciones = async () => {
        const v = num(await activos[0].balanceOf(ufx)) * num(await oraculo.precio(activos[0]));
        return v / num(await ufx.valorReserva());
      };
      await avanzar(DIA, { precios: [85, 95, 95] }); // reserva ~4.600 / deuda ~4.000 → ~114%
      await expect(ufx.mantener()).to.emit(ufx, "ModoDefensivo").withArgs(true, (r) => r < 11500n);
      expect(await ufx.modoDefensivo()).to.equal(true);
      expect(await pesoAcciones()).to.be.closeTo(0.10, 1e-6);
      await avanzar(DIA, { precios: [150, 130, 130] }); // se recupera con fuerza
      await expect(ufx.mantener()).to.emit(ufx, "ModoDefensivo").withArgs(false, (r) => r >= 12500n);
      expect(await pesoAcciones()).to.be.closeTo(0.40, 1e-6);
    });

    it("no sale del modo defensivo por una recuperación chica (histéresis de 10 puntos)", async function () {
      const { ufx, avanzar } = await loadFixture(defensivo);
      await avanzar(DIA, { precios: [85, 95, 95] });
      await ufx.mantener();
      await avanzar(DIA, { precios: [90, 97, 97] }); // apenas sobre el umbral
      await expect(ufx.mantener()).to.not.emit(ufx, "ModoDefensivo");
      expect(await ufx.modoDefensivo()).to.equal(true);
    });

    it("rechaza pesos defensivos que no suman 100%", async function () {
      await expect(desplegar({ umbral: 13000, pesosDefensivos: [1000, 6000, 2000] })).to.be.revertedWith("pesos defensivos deben sumar 100%");
    });
  });

  describe("Prueba al azar: 400 operaciones", function () {
    it("el precio nunca baja, salir siempre funciona y al final no queda plata atrapada", async function () {
      this.timeout(300000);
      const f = await loadFixture(desplegar);
      const { ufx, dolar, dar, avanzar, estado } = f;
      const usuarios = (await ethers.getSigners()).slice(6, 16);
      const colchoneros = [f.fondo, f.beto];
      let semilla = 12345;
      const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

      await dar(f.fondo, 1e6);
      await dar(f.beto, 1e6);
      for (const u of usuarios) await dar(u, 1e6);
      await ufx.connect(f.fondo).aportarColchon(e18(1000));

      let entra = 1000, sale = 0, precioPrevio = num(await ufx.precioUnidad());
      const esperados = ["respaldo bajo 120%", "dejaria la reserva bajo 120%", "colchon agotado"];
      const intentar = async (p) => {
        try { await p; return true; } catch (e) {
          if (!esperados.some((m) => e.message.includes(m))) throw e;
          return false;
        }
      };

      for (let paso = 0; paso < 400; paso++) {
        const r = azar();
        if (r < 0.3) {
          const u = usuarios[Math.floor(azar() * usuarios.length)];
          const monto = 1 + azar() * 2000;
          if (await intentar(ufx.connect(u).acunar(e18(monto)))) entra += monto;
        } else if (r < 0.5) {
          const u = usuarios[Math.floor(azar() * usuarios.length)];
          const bal = await ufx.balanceOf(u.address);
          if (bal > 0n) {
            const antes = await dolar.balanceOf(u.address);
            await ufx.connect(u).quemar((bal * BigInt(1 + Math.floor(azar() * 100))) / 100n); // nunca debe fallar
            sale += num((await dolar.balanceOf(u.address)) - antes);
          }
        } else if (r < 0.62) {
          const c = colchoneros[Math.floor(azar() * 2)];
          const monto = 100 + azar() * 3000;
          if (await intentar(ufx.connect(c).aportarColchon(e18(monto)))) entra += monto;
        } else if (r < 0.7) {
          const c = colchoneros[Math.floor(azar() * 2)];
          const partes = await ufx.partesColchon(c.address);
          if (partes > 0n) {
            const antes = await dolar.balanceOf(c.address);
            if (await intentar(ufx.connect(c).retirarColchon(partes / 3n + 1n))) sale += num((await dolar.balanceOf(c.address)) - antes);
          }
        } else {
          // pasa un mes: los precios se mueven entre -12% y +12%, inflación 0–0,6%, T-bills 0–6%
          await avanzar(30 * DIA, {
            precios: estado.precios.map((p) => p * (0.88 + azar() * 0.24)),
            ipc: estado.ipc * (1 + azar() * 0.006),
            tbill: azar() * 0.06,
          });
          if (azar() < 0.1) await ufx.rebalancear();
        }
        const precio = num(await ufx.precioUnidad());
        expect(precio).to.be.at.least(precioPrevio - 1e-12, `el precio bajó en el paso ${paso}`);
        precioPrevio = precio;
      }

      // Todos salen: primero UFX, después el colchón (incluido el fundador).
      for (const u of usuarios) {
        const bal = await ufx.balanceOf(u.address);
        if (bal > 0n) {
          const antes = await dolar.balanceOf(u.address);
          await ufx.connect(u).quemar(bal);
          sale += num((await dolar.balanceOf(u.address)) - antes);
        }
      }
      expect(await ufx.totalSupply()).to.equal(0n);
      await avanzar(ANIO + DIA);
      for (const c of [f.fondo, f.beto, f.fundador]) {
        const partes = await ufx.partesColchon(c.address);
        if (partes > 0n) {
          const antes = await dolar.balanceOf(c.address);
          await ufx.connect(c).retirarColchon(ethers.MaxUint256);
          sale += num((await dolar.balanceOf(c.address)) - antes);
        }
      }
      expect(await ufx.partesColchonTotal()).to.equal(0n);
      expect(num(await ufx.valorReserva())).to.be.lessThan(0.01); // nada atrapado
      console.log(`      entraron ${entra.toFixed(0)} USD, salieron ${sale.toFixed(0)} USD, precio final UFX ${precioPrevio.toFixed(4)}`);
    });
  });
});
