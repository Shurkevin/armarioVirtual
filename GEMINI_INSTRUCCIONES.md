# Instrucciones para Gemini

Este documento resume las instrucciones activas que el backend envía a Gemini. La fuente ejecutable es [server/index.mjs](server/index.mjs).

## Análisis de outfits

### Alcance y privacidad

- Responder siempre en español.
- Analizar únicamente prendas y accesorios visibles.
- No identificar personas ni inferir género, edad, etnia u otros rasgos personales.
- Separar sujetos protagonistas de personas incidentales, reflejos, figuras lejanas o parcialmente visibles.
- Un sujeto se considera protagonista solo si está en primer plano o plano medio, ocupa una parte relevante de la imagen y su outfit se aprecia con claridad.
- Ordenar los protagonistas de izquierda a derecha, con IDs consecutivos.
- Los bebés y niños muy pequeños se ignoran por completo: no son seleccionables y su ropa o accesorios no se asignan a los adultos.

### Exclusiones

- No detectar auriculares, cascos, earbuds, AirPods ni dispositivos de sonido como prenda o accesorio.
- Contar un par de zapatos o zapatillas como una sola prenda y usar un recuadro que abarque ambos.

### Personas, prendas y recortes

- Devolver `foregroundSubject` y `prominence` para cada persona.
- Devolver `faceVisible` y `faceBox` en coordenadas normalizadas de 0 a 1000; usar ceros si no se aprecia la cara.
- Devolver un `itemBox` ajustado por cada prenda, también en coordenadas de 0 a 1000.
- Indicar `displayRotation` (`0`, `90`, `180` o `270`) según el eje propio del objeto recortado, ignorando la inclinación de la persona o de la foto. Las gafas deben verse con las lentes en horizontal y la ropa erguida.

### Clasificación de prendas

- Categorías generales permitidas: `ropa superior`, `ropa inferior`, `prenda de cuerpo entero`, `abrigo`, `calzado` y `accesorio`.
- Devolver categoría, subcategoría, color principal, colores secundarios, estilos y estampado.
- Ser preciso con el color: si hay varios colores visibles, el `primaryColor` debe expresar la combinación (por ejemplo, `blanco y negro` para una camisa de rayas blancas y negras), y `secondaryColors` debe listar todos los colores claramente apreciables. No usar únicamente el color dominante ni omitir rayas, cuadros, bloques o estampados bicolor.
- Solo informar de una marca si el nombre o logotipo es visible y reconocible de forma inequívoca. Si no, devolver una cadena vacía.
- Diferenciar composición aparente (`materialEstimate`) de construcción del tejido (`fabricType`).
- No afirmar una composición exacta sin evidencia visual; usar `no determinable` o `mezcla probable` con baja confianza cuando corresponda.
- Devolver textura visible, confianza específica del material y confianza general.

### Valoración del outfit

- Generar por persona `outfitEvaluation` con `score`, `summary`, `strengths`, `improvements` y `suggestions`.
- Basarse exclusivamente en coordinación de colores, equilibrio, ocasión y acabado del conjunto visible.
- Ser amable y accionable; no juzgar cuerpo, atractivo, género, edad ni rasgos personales.
- Las mejoras deben ser estéticas y de styling. No sugerir prendas por clima, comodidad, protección, utilidad, seguridad o planes hipotéticos.
- Usar una escala positiva y algo generosa:
  - 80–89: conjunto bien coordinado y apropiado.
  - 90–94: conjunto especialmente logrado.
  - 95–100: resultado excepcional.
  - Menos de 70 solo ante problemas visuales claros y relevantes.

## Comparación de prendas duplicadas

Al comparar una foto nueva con una prenda ya guardada:

- Decidir si es exactamente la misma prenda física, no solo el mismo tipo o color.
- Considerar corte, costuras, estampado, logotipo, textura y detalles distintivos.
- Tolerar cambios de pose, iluminación, escala u oclusión.
- Devolver `sameGarment`, `confidence`, `reason` y `bestImage`.
- Elegir `candidate` como `bestImage` si la nueva imagen muestra mejor nitidez, tamaño, integridad y menor oclusión; en caso contrario elegir `saved`.

## Corrección específica de orientación de gafas

Cuando unas gafas se detectan en vertical, se realiza una segunda consulta:

- Evaluar exclusivamente las gafas dentro de su `itemBox`.
- Ignorar persona, postura, fondo y texto situado detrás.
- Elegir únicamente una rotación de `90` o `270` grados en sentido horario.
- La orientación final debe dejar montura superior arriba, lentes con su parte inferior abajo y patillas en una posición natural de catálogo.

## Configuración técnica actual

- Modelo por defecto: `gemini-3.5-flash-lite`.
- Nivel de razonamiento por defecto: `minimal`.
- El análisis de outfit exige JSON estructurado y tiene un límite de 4096 tokens de salida.
- La comparación exige JSON estructurado y tiene un límite de 256 tokens de salida.
