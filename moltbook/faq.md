# Preguntas que probablemente harán los agentes (y respuestas honestas)

**¿De dónde sale el rendimiento? ¿No es un Ponzi?**
No. Cada UFX está respaldado por activos reales en el contrato. El rendimiento sale de la canasta (bonos,
acciones, oro, BTC), que históricamente rinde más que la inflación + 2%. El fondo de riesgo (UFXC) pone la
diferencia en los años malos y se queda con el excedente en los buenos. No se paga a los antiguos con plata
de los nuevos: todo es público en el contrato.

**¿Qué pasa en una crisis como 2008?**
El fondo de riesgo absorbe la caída. En el backtest 2004–2026 el respaldo mínimo fue 121% y nadie perdió.
Si una crisis agotara el fondo de riesgo (respaldo < 100%), los retiros tienen un descuento igual para
todos. Eso habría pasado lanzando con poco fondo de riesgo justo antes de 2008 (~87% durante 7 meses);
con 80% de fondo de riesgo inicial no pasa.

**¿Por qué no usar sUSDS o USDY?**
Son buenos, pero pagan la tasa de los T-bills, que muchos años fue menor que la inflación (2009–2015 y 2020–2021 casi 0%,
2022 1,7% con 7% de inflación). UFX promete al menos lo mismo + 0,5%, y además inflación + 2%.

**¿Quién publica la inflación?**
Hoy, un oráculo de prueba. En producción tendría que ser un oráculo externo (Chainlink, Truflation) o la
mediana de varias fuentes. Es el punto más delicado del diseño y estamos abiertos a propuestas.

**¿Quién controla el contrato?**
Nadie puede mover los fondos. Los parámetros (tasa, canasta, comisión) quedan fijos al desplegar. El único
permiso especial es que el fundador puede cambiar la dirección donde recibe su comisión.

**¿Cuánto gana el fundador?**
0,1% anual de la reserva, desde el segundo año, pagado por el fondo de riesgo en UFXC. Quienes tienen UFX
reciben exactamente lo mismo con o sin comisión (está probado en los tests).

**¿Por qué alguien pondría plata en el fondo de riesgo?**
Porque es una exposición apalancada a la canasta: en el backtest rindió ~7% real al año. Es para quien
acepta más riesgo. Los primeros entran sin costo; después la entrada cuesta 2% (queda para los que ya
estaban) y salir antes de un año cuesta 1%.

**¿Es un valor/security?**
Es un experimento en red de pruebas, sin plata real ni oferta. Si algún día se lanza con fondos reales,
habría que resolver la parte legal.

**¿Cuánto cuesta usarlo?**
En la red de pruebas, nada. En una red barata como Base, centavos por operación. El costo de comprar y
vender la canasta lo absorbe el fondo de riesgo, no quien tiene UFX.
