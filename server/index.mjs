import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import cors from 'cors';
import express from 'express';
import multer from 'multer';

const app = express();
const port = Number(process.env.PORT || 3001);
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const GEMINI_RETRY_DELAYS_MS = [2500, 6000, 12000];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fetchGeminiWithRetry = async ({ url, options, log }) => {
  let lastNetworkError;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 503 || attempt === GEMINI_RETRY_DELAYS_MS.length) return response;
      const delay = GEMINI_RETRY_DELAYS_MS[attempt];
      log(`Gemini está temporalmente saturado (HTTP 503). Reintentaremos en ${Math.round(delay / 1000)} s (${attempt + 1}/${GEMINI_RETRY_DELAYS_MS.length}).`);
      await response.body?.cancel();
      await wait(delay);
    } catch (error) {
      lastNetworkError = error;
      if (attempt === GEMINI_RETRY_DELAYS_MS.length) throw error;
      const delay = GEMINI_RETRY_DELAYS_MS[attempt];
      log(`No se ha podido contactar con Gemini. Reintentaremos en ${Math.round(delay / 1000)} s (${attempt + 1}/${GEMINI_RETRY_DELAYS_MS.length}).`);
      await wait(delay);
    }
  }
  throw lastNetworkError || new Error('Gemini no ha respondido tras varios intentos.');
};
const normalizedText = (value = '') => value.trim().toLocaleLowerCase('es');
const isFootwear = (item) => {
  const description = `${normalizedText(item.category)} ${normalizedText(item.subcategory)}`;
  return ['calzado', 'zapatill', 'zapato', 'bota', 'sandalia', 'mocasin', 'mocasín', 'tacon', 'tacón'].some((term) => description.includes(term));
};
const isExcludedAudioAccessory = (item) => {
  const description = normalizedText(`${item.category || ''} ${item.subcategory || ''}`);
  return ['auricular', 'audifono', 'audífono', 'headphone', 'earphone', 'earbud', 'airpod', 'cascos de audio'].some((term) => description.includes(term));
};
const footwearKind = (item) => {
  const description = normalizedText(item.subcategory);
  return ['zapatill', 'zapato', 'bota', 'sandalia', 'mocasin', 'mocasín', 'tacon', 'tacón'].find((term) => description.includes(term)) || description;
};
const mergeBox = (first, second) => ({
  xMin: Math.min(first.xMin, second.xMin),
  yMin: Math.min(first.yMin, second.yMin),
  xMax: Math.max(first.xMax, second.xMax),
  yMax: Math.max(first.yMax, second.yMax),
});
const mergeFootwearPairs = (items = []) => {
  const merged = [];
  for (const item of items) {
    if (!isFootwear(item)) {
      merged.push(item);
      continue;
    }
    const match = merged.find((candidate) => isFootwear(candidate)
      && footwearKind(candidate) === footwearKind(item)
      && normalizedText(candidate.primaryColor) === normalizedText(item.primaryColor)
      && normalizedText(candidate.brand) === normalizedText(item.brand));
    if (!match) {
      merged.push(item);
      continue;
    }
    match.itemBox = mergeBox(match.itemBox, item.itemBox);
    match.confidence = Math.max(match.confidence, item.confidence);
    match.materialConfidence = Math.max(match.materialConfidence, item.materialConfidence);
  }
  return merged;
};
const applyObjectDisplayRotation = (item) => {
  const description = normalizedText(`${item.category} ${item.subcategory}`);
  const modelDisplayRotation = item.displayRotation;
  const isGlasses = ['gafas', 'anteojos', 'lentes de sol'].some((term) => description.includes(term));
  if (isGlasses) {
    const boxWidth = item.itemBox.xMax - item.itemBox.xMin;
    const boxHeight = item.itemBox.yMax - item.itemBox.yMin;
    if (boxHeight > boxWidth * 1.15) item.displayRotation = 0;
    else if (boxWidth > boxHeight * 1.15) item.displayRotation = 0;
  }
  item.modelDisplayRotation = modelDisplayRotation;
  return item;
};
const needsGlassesOrientationCheck = (item) => {
  const description = normalizedText(`${item.category} ${item.subcategory}`);
  const isGlasses = ['gafas', 'anteojos', 'lentes de sol'].some((term) => description.includes(term));
  return isGlasses && (item.itemBox.yMax - item.itemBox.yMin) > (item.itemBox.xMax - item.itemBox.xMin) * 1.15;
};
const resolveGlassesRotation = async ({ image, mimeType, item, model, apiKey, log }) => {
  const box = item.itemBox;
  log(`Comprobando el sentido correcto del giro para ${item.subcategory || item.category}…`);
  const startedAt = Date.now();
  const waitingLog = setInterval(() => log(`Gemini sigue evaluando la orientación del objeto… ${Math.round((Date.now() - startedAt) / 1000)} s.`), 5000);
  try {
    const geminiResponse = await fetchGeminiWithRetry({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: `Evalúa exclusivamente las gafas contenidas en la caja normalizada xMin=${box.xMin}, yMin=${box.yMin}, xMax=${box.xMax}, yMax=${box.yMax}. El objeto está vertical y debe quedar horizontal. Ignora por completo la persona, la postura, el fondo y cualquier texto que haya detrás. Escoge 90 o 270 grados en sentido horario según cuál deje las gafas del derecho en una presentación de catálogo: montura superior arriba, parte inferior de las lentes abajo y patillas en orientación natural.` },
          { inlineData: { mimeType, data: image.toString('base64') } },
        ] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'minimal' },
          maxOutputTokens: 64,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object', additionalProperties: false,
            properties: { rotation: { type: 'integer', enum: [90, 270] } },
            required: ['rotation'],
          },
        },
        }),
      },
      log,
    });
    const result = await geminiResponse.json();
    if (!geminiResponse.ok) throw new Error(result?.error?.message || 'Error de Gemini al orientar el objeto.');
    const outputText = result?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    const rotation = JSON.parse(outputText || '{}').rotation;
    if (![90, 270].includes(rotation)) throw new Error('Gemini no devolvió un giro válido.');
    log(`Orientación específica del objeto resuelta en ${Date.now() - startedAt} ms: ${rotation}°.`);
    return rotation;
  } finally {
    clearInterval(waitingLog);
  }
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, file.mimetype.startsWith('image/')),
});

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin(origin, callback) {
    // Native clients do not always send an Origin header. Browser clients do.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origen no permitido.'));
  },
}));
app.use((request, response, next) => {
  response.setTimeout(Number(process.env.REQUEST_TIMEOUT_MS || 120000), () => {
    if (!response.headersSent) response.status(408).json({ error: 'La solicitud ha tardado demasiado.' });
    request.destroy();
  });
  next();
});

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.post('/compare-garments', upload.fields([{ name: 'candidate', maxCount: 1 }, { name: 'saved', maxCount: 1 }]), async (request, response) => {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const log = (message) => console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);
  const candidate = request.files?.candidate?.[0];
  const saved = request.files?.saved?.[0];
  if (!candidate || !saved) return response.status(400).json({ error: 'Faltan las dos fotos que hay que comparar.' });
  if (!process.env.GEMINI_API_KEY) return response.status(503).json({ error: 'El servidor no tiene configurada GEMINI_API_KEY.' });

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    log(`Fotos de comparación recibidas: nueva ${(candidate.size / 1024).toFixed(0)} KB, guardada ${(saved.size / 1024).toFixed(0)} KB.`);
    log(`Comparando visualmente dos prendas con Gemini (${model})…`);
    const geminiStartedAt = Date.now();
    const waitingLog = setInterval(() => log(`Gemini sigue comparando las prendas… ${Math.round((Date.now() - geminiStartedAt) / 1000)} s de espera.`), 5000);
    let geminiResponse;
    try {
      geminiResponse = await fetchGeminiWithRetry({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: 'Compara estas dos fotos recortadas de prendas. Determina si probablemente muestran exactamente la misma prenda física, aunque cambien la pose, iluminación, escala u oclusión. No basta con que sean del mismo tipo y color: busca coincidencias en corte, costuras, estampado, logotipo, textura y detalles distintivos. La primera imagen es la nueva y la segunda ya está en el armario. Indica también en bestImage cuál es mejor como foto principal de armario: candidate si la nueva muestra la prenda con más nitidez, tamaño, integridad y menos oclusiones; saved si la guardada es mejor.' },
          { text: 'IMAGEN NUEVA' },
          { inlineData: { mimeType: candidate.mimetype, data: candidate.buffer.toString('base64') } },
          { text: 'IMAGEN GUARDADA' },
          { inlineData: { mimeType: saved.mimetype, data: saved.buffer.toString('base64') } },
        ] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'minimal' },
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sameGarment: { type: 'boolean' },
              confidence: { type: 'number' },
              reason: { type: 'string' },
              bestImage: { type: 'string', enum: ['candidate', 'saved'] },
            },
            required: ['sameGarment', 'confidence', 'reason', 'bestImage'],
          },
        },
        }),
      },
      log,
      });
    } finally {
      clearInterval(waitingLog);
    }
    log(`Gemini ha respondido a la comparación con HTTP ${geminiResponse.status} tras ${Date.now() - geminiStartedAt} ms.`);
    const result = await geminiResponse.json();
    if (!geminiResponse.ok) throw Object.assign(new Error(result?.error?.message || 'Error de Gemini'), { status: geminiResponse.status });
    const outputText = result?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!outputText) throw new Error('Gemini no devolvió una comparación utilizable.');
    const comparison = JSON.parse(outputText);
    log(`Comparación completada en ${Date.now() - startedAt} ms: ${comparison.sameGarment ? 'posible duplicado' : 'prendas distintas'} (${Math.round(comparison.confidence * 100)}%).`);
    response.json(comparison);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Error comparando prendas:`, error?.message || error);
    response.status(502).json({ error: 'No se han podido comparar visualmente las prendas.' });
  }
});

app.post('/analyze-outfit', upload.single('photo'), async (request, response) => {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const log = (message) => console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);

  log('Nueva solicitud de análisis.');
  if (!request.file) {
    log('Solicitud rechazada: no contiene una foto.');
    return response.status(400).json({ error: 'Falta la foto.' });
  }
  log(`Foto recibida: ${request.file.mimetype}, ${(request.file.size / 1024 / 1024).toFixed(2)} MB.`);

  if (!process.env.GEMINI_API_KEY) {
    log('Solicitud rechazada: GEMINI_API_KEY no está configurada.');
    return response.status(503).json({ error: 'El servidor no tiene configurada GEMINI_API_KEY.' });
  }

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    log(`Enviando la imagen a Gemini (${model})…`);
    const geminiStartedAt = Date.now();
    const waitingLog = setInterval(() => {
      const waitingSeconds = Math.round((Date.now() - geminiStartedAt) / 1000);
      log(`Gemini sigue procesando la imagen… ${waitingSeconds} s de espera.`);
    }, 5000);
    let geminiResponse;
    try {
      geminiResponse = await fetchGeminiWithRetry({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      options: {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
        body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Analiza exclusivamente las prendas y accesorios visibles. Responde en español. No identifiques a nadie ni infieras género, edad, etnia u otros rasgos personales. Distingue cuidadosamente a los sujetos protagonistas de las personas incidentales del fondo. Una persona es foregroundSubject solo si está en primer plano o plano medio, ocupa una parte significativa de la imagen y su outfit puede analizarse con claridad. Transeúntes, gente distante, figuras pequeñas, reflejos y personas parcialmente visibles del fondo nunca son foregroundSubject. Si hay varios protagonistas reales, sepáralos por su posición visual de izquierda a derecha. Localiza la cara de cada persona y cada prenda mediante rectángulos ajustados en coordenadas normalizadas de 0 a 1000. Calcula displayRotation mirando exclusivamente el eje y la orientación del objeto dentro de su propio itemBox; ignora por completo la postura, inclinación y orientación de la persona y de la foto completa. Indica si ese objeto recortado debe rotarse 0, 90, 180 o 270 grados en sentido horario para verse en orientación convencional de catálogo: las dos lentes de unas gafas deben quedar una junto a otra en horizontal y la ropa debe quedar erguida. Cuenta siempre un par de calzado como una única prenda, no como dos objetos; su itemBox debe abarcar ambos zapatos o zapatillas. Usa siempre una de estas categorías generales: ropa superior, ropa inferior, prenda de cuerpo entero, abrigo, calzado o accesorio. Distingue entre composición aparente (por ejemplo algodón, lino, poliéster, lana o mezcla) y construcción del tejido (por ejemplo punto, tejido plano, denim o cuero). No afirmes una composición exacta si no es visualmente verificable: usa "no determinable" o "mezcla probable" y una confianza baja. Solo informa de una marca cuando su nombre o logotipo sea claramente visible y reconocible en esa prenda; no la deduzcas por el diseño, el estilo o el contexto. Si no es inequívoca, devuelve una cadena vacía.' }],
        },
        contents: [{
          role: 'user',
          parts: [
            { text: 'No incluyas auriculares, cascos de audio, earbuds, AirPods ni ningún otro dispositivo de sonido entre las prendas o accesorios.' },
            { text: 'No tengas en cuenta bebés ni niños muy pequeños: no los devuelvas como personas seleccionables, no enumeres sus prendas y no confundas su ropa o accesorios con los de los adultos que aparecen en la foto. Si hay al menos uno claramente visible, establece youngChildDetected en true; úsalo únicamente como señal de exclusión, sin estimar edades ni describir al menor.' },
            { text: 'En la valoración del outfit usa un criterio positivo y ligeramente más generoso: un conjunto bien coordinado y apropiado puede estar en 80-89; reserva 90-94 para conjuntos especialmente logrados y 95-100 solo para resultados excepcionales. Usa notas inferiores a 70 únicamente si hay problemas visuales claros y relevantes.' },
            { text: 'Detecta las personas visibles y valora para cada una foregroundSubject y prominence entre 0 y 1. Ordénalas de izquierda a derecha y asigna ids consecutivos empezando por 1. Describe su posición brevemente sin usar rasgos personales. Indica si su cara es visible y devuelve faceBox con xMin, yMin, xMax e yMax entre 0 y 1000; si no es visible usa ceros. Para cada persona enumera las prendas y accesorios que lleva y genera outfitEvaluation: una valoración breve y amable basada solo en lo visible del conjunto (coordinación de colores, equilibrio, ocasión y acabado), con score de 0 a 100, summary, 1-3 strengths, 1-3 improvements y 1-3 suggestions accionables de vestimenta que harían que el conjunto combinase o se viera mejor. Usa una escala exigente y amplia: 50-59 es un conjunto correcto pero con varios aspectos visuales mejorables; 60-69 es bueno; 70-79 muy bueno; 80-89 excelente y coherente; 90-94 sobresaliente; reserva 95-100 para estilismos excepcionales, impecables y especialmente memorables. No concentres las puntuaciones entre 80 y 88: penaliza de forma proporcionada incompatibilidades de color, proporción, formalidad, acabado o falta de intención estilística. Las mejoras deben ser exclusivamente estéticas y de styling: no recomiendes prendas por el clima, comodidad, protección, utilidad, seguridad ni planes hipotéticos (por ejemplo, no sugieras añadir una chaqueta por si cambia el tiempo). No juzgues el cuerpo, atractivo, género, edad ni rasgos personales, y no inventes prendas que no se vean. Para cada prenda devuelve itemBox, un rectángulo lo más ajustado posible con xMin, yMin, xMax e yMax entre 0 y 1000. Incluye categoría, subcategoría, color principal, colores secundarios, estilos, estampado, marca claramente visible en brand (o cadena vacía), composición aparente en materialEstimate, tipo de construcción en fabricType, textura visible en texture, confianza específica del material entre 0 y 1 y confianza general entre 0 y 1. En el color sé preciso y descriptivo: color principal debe incluir la combinación cuando la prenda tenga varios colores visibles (por ejemplo, “blanco y negro” para una camisa de rayas blancas y negras), colores secundarios debe listar todos los colores claramente apreciables y su orden no importa. No uses solo el color dominante ni omitas rayas, cuadros, bloques o estampados bicolor; si un color ocupa una parte relevante, inclúyelo aunque sea secundario.' },
            { inlineData: { mimeType: request.file.mimetype, data: request.file.buffer.toString('base64') } },
          ],
        }],
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'minimal',
          },
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              youngChildDetected: { type: 'boolean' },
              people: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'integer' },
                    position: { type: 'string' },
                    foregroundSubject: { type: 'boolean' },
                    prominence: { type: 'number' },
                    faceVisible: { type: 'boolean' },
                    faceBox: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        xMin: { type: 'number' },
                        yMin: { type: 'number' },
                        xMax: { type: 'number' },
                        yMax: { type: 'number' },
                      },
                      required: ['xMin', 'yMin', 'xMax', 'yMax'],
                    },
                    outfitEvaluation: {
                      type: 'object', additionalProperties: false,
                      properties: {
                        score: { type: 'number' }, summary: { type: 'string' },
                        strengths: { type: 'array', items: { type: 'string' } },
                        improvements: { type: 'array', items: { type: 'string' } },
                        suggestions: { type: 'array', items: { type: 'string' } },
                      }, required: ['score', 'summary', 'strengths', 'improvements', 'suggestions'],
                    },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          category: { type: 'string' },
                          subcategory: { type: 'string' },
                          primaryColor: { type: 'string' },
                          secondaryColors: { type: 'array', items: { type: 'string' } },
                          styles: { type: 'array', items: { type: 'string' } },
                          pattern: { type: 'string' },
                          brand: { type: 'string' },
                          materialEstimate: { type: 'string' },
                          fabricType: { type: 'string' },
                          texture: { type: 'string' },
                          materialConfidence: { type: 'number' },
                          confidence: { type: 'number' },
                          displayRotation: { type: 'integer', enum: [0, 90, 180, 270] },
                          itemBox: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                              xMin: { type: 'number' },
                              yMin: { type: 'number' },
                              xMax: { type: 'number' },
                              yMax: { type: 'number' },
                            },
                            required: ['xMin', 'yMin', 'xMax', 'yMax'],
                          },
                        },
                        required: ['category', 'subcategory', 'primaryColor', 'secondaryColors', 'styles', 'pattern', 'brand', 'materialEstimate', 'fabricType', 'texture', 'materialConfidence', 'confidence', 'displayRotation', 'itemBox'],
                      },
                    },
                  },
                  required: ['id', 'position', 'foregroundSubject', 'prominence', 'faceVisible', 'faceBox', 'outfitEvaluation', 'items'],
                },
              },
            },
            required: ['youngChildDetected', 'people'],
          },
        },
        }),
      },
      log,
      });
    } finally {
      clearInterval(waitingLog);
    }

    log(`Cabeceras recibidas de Gemini: HTTP ${geminiResponse.status} tras ${Date.now() - geminiStartedAt} ms.`);
    const responseBodyStartedAt = Date.now();
    const result = await geminiResponse.json();
    log(`Respuesta de Gemini descargada y parseada en ${Date.now() - responseBodyStartedAt} ms.`);
    if (!geminiResponse.ok) {
      const providerError = new Error(result?.error?.message || 'Error de Gemini');
      providerError.status = geminiResponse.status;
      throw providerError;
    }

    const candidate = result?.candidates?.[0];
    const finishReason = candidate?.finishReason || 'UNKNOWN';
    log(`Finalización de Gemini: ${finishReason}.`);
    const outputText = candidate?.content?.parts?.find((part) => part.text)?.text;
    if (!outputText) throw new Error('Gemini no devolvió un análisis utilizable.');
    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch {
      const detail = finishReason === 'MAX_TOKENS'
        ? 'La respuesta de Gemini se quedó sin espacio antes de completar el análisis.'
        : 'Gemini devolvió un JSON incompleto o no válido.';
      const parseError = new Error(detail);
      parseError.status = 422;
      throw parseError;
    }
    const detectedPeople = analysis.people || [];
    analysis.people = detectedPeople.filter((person) => person.foregroundSubject && person.prominence >= 0.45);
    const ignoredPeopleCount = detectedPeople.length - analysis.people.length;
    if (ignoredPeopleCount > 0) log(`${ignoredPeopleCount} personas incidentales del fondo ignoradas.`);
    let mergedFootwearCount = 0;
    let excludedAudioCount = 0;
    analysis.people = analysis.people.map((person) => {
      const originalCount = person.items?.length || 0;
      const wardrobeItems = (person.items || []).filter((item) => !isExcludedAudioAccessory(item));
      excludedAudioCount += originalCount - wardrobeItems.length;
      const items = mergeFootwearPairs(wardrobeItems).map(applyObjectDisplayRotation);
      mergedFootwearCount += wardrobeItems.length - items.length;
      return { ...person, items };
    });
    if (excludedAudioCount > 0) log(`${excludedAudioCount} dispositivos de audio excluidos del armario.`);
    if (mergedFootwearCount > 0) log(`${mergedFootwearCount} duplicados de calzado fusionados como pares.`);
    for (const person of analysis.people) {
      for (const item of person.items || []) {
        if (needsGlassesOrientationCheck(item)) {
          try {
            item.displayRotation = await resolveGlassesRotation({
              image: request.file.buffer,
              mimeType: request.file.mimetype,
              item,
              model,
              apiKey: process.env.GEMINI_API_KEY,
              log,
            });
          } catch (orientationError) {
            item.displayRotation = 0;
            log(`No se pudo resolver con seguridad el sentido del giro de ${item.subcategory || item.category}; no se aplicará una rotación automática.`);
          }
        }
        const boxWidth = Math.round(item.itemBox.xMax - item.itemBox.xMin);
        const boxHeight = Math.round(item.itemBox.yMax - item.itemBox.yMin);
        log(`Orientación del objeto: persona ${person.id}, ${item.subcategory || item.category}, Gemini=${item.modelDisplayRotation}°, aplicada=${item.displayRotation}°, caja=${boxWidth}x${boxHeight}.`);
      }
    }
    const garmentCount = analysis.people?.reduce((total, person) => total + (person.items?.length || 0), 0) || 0;
    log(`Análisis completado: ${analysis.people?.length || 0} personas y ${garmentCount} prendas detectadas en ${Date.now() - startedAt} ms.`);
    response.json(analysis);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Error tras ${Date.now() - startedAt} ms:`, error?.message || error);
    if (error?.status === 503) {
      return response.status(503).json({
        error: 'Gemini está temporalmente saturado. Hemos reintentado el análisis varias veces; prueba de nuevo en un momento.',
      });
    }
    if (error?.status === 429) {
      return response.status(429).json({
        error: 'Has alcanzado temporalmente el límite gratuito de Gemini. Espera un poco y vuelve a intentarlo.',
      });
    }
    if (error?.status === 404) {
      return response.status(502).json({
        error: 'El modelo de análisis ya no está disponible. Actualiza GEMINI_MODEL en el servidor.',
      });
    }
    if (error?.status === 422) {
      return response.status(422).json({ error: error.message });
    }
    response.status(502).json({ error: 'No se ha podido analizar la imagen.' });
  }
});

app.listen(port, '0.0.0.0', () => {
  const localAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => address.address);

  console.log('Servidor de Armario listo:');
  console.log(`  Mac:   http://localhost:${port}`);
  if (localAddresses.length > 0) {
    localAddresses.forEach((address) => console.log(`  Móvil: http://${address}:${port}`));
  } else {
    console.log('  Móvil: no se ha encontrado una IP local');
  }
});
