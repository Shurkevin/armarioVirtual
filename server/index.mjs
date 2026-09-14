import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';

const app = express();
const port = Number(process.env.PORT || 3001);
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const GEMINI_RETRY_DELAYS_MS = [2500, 6000, 12000];
const NO_SPECIFIC_OCCASION = 'Ninguna en concreto';
const OUTFIT_OCCASIONS = new Set(['Día a día', 'Trabajo o estudios', 'Salir, cena o cita', 'Evento o celebración', 'Actividad o deporte', NO_SPECIFIC_OCCASION]);
const LEGACY_OUTFIT_STYLE_GOALS = new Set(['Casual', 'Minimalista', 'Clásico', 'Urbano', 'Deportivo', 'Elegante']);
const COMPARISON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COMPARISON_CACHE_MAX_ENTRIES = 500;
const COMPARISON_PROMPT_VERSION = 'v4';
const comparisonCache = new Map();
const imageDigest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const perceptualImageHash = async (buffer) => {
  const pixels = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      hash = (hash << 1n) | (pixels[(row * 9) + column] > pixels[(row * 9) + column + 1] ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(16, '0');
};
const requestSupabaseClient = (request) => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const authorization = request.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw Object.assign(new Error('Falta la sesión del usuario.'), { status: 401 });
  if (!supabaseUrl || !supabaseAnonKey) throw Object.assign(new Error('Supabase no está configurado en el servidor.'), { status: 503 });
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
};
const readPersistentComparisonCache = async (supabase, key, log) => {
  const { data, error } = await supabase
    .from('garment_comparison_cache')
    .select('result, expires_at')
    .eq('candidate_hash', key.candidateHash)
    .eq('saved_hash', key.savedHash)
    .eq('candidate_digest', key.candidateDigest)
    .eq('saved_digest', key.savedDigest)
    .eq('model', key.model)
    .eq('retry_model', key.retryModel)
    .eq('thinking_level', key.thinkingLevel)
    .eq('prompt_version', COMPARISON_PROMPT_VERSION)
    .maybeSingle();
  if (error) {
    log(`Caché persistente no disponible: ${error.message}`);
    return null;
  }
  if (!data || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data.result;
};
const writePersistentComparisonCache = async (supabase, key, comparison, userId, savedGarmentId, log) => {
  const { error } = await supabase.from('garment_comparison_cache').upsert({
    user_id: userId,
    saved_garment_id: savedGarmentId,
    candidate_hash: key.candidateHash,
    saved_hash: key.savedHash,
    candidate_digest: key.candidateDigest,
    saved_digest: key.savedDigest,
    model: key.model,
    retry_model: key.retryModel,
    thinking_level: key.thinkingLevel,
    prompt_version: COMPARISON_PROMPT_VERSION,
    result: comparison,
    expires_at: new Date(Date.now() + COMPARISON_CACHE_TTL_MS).toISOString(),
  }, { onConflict: 'user_id,candidate_digest,saved_digest,model,retry_model,thinking_level,prompt_version' });
  if (error) log(`No se ha podido persistir la caché de comparación: ${error.message}`);
};
const readComparisonCache = (key) => {
  const entry = comparisonCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    comparisonCache.delete(key);
    return null;
  }
  comparisonCache.delete(key);
  comparisonCache.set(key, entry);
  return entry.value;
};
const writeComparisonCache = (key, value) => {
  comparisonCache.set(key, { value, expiresAt: Date.now() + COMPARISON_CACHE_TTL_MS });
  while (comparisonCache.size > COMPARISON_CACHE_MAX_ENTRIES) {
    comparisonCache.delete(comparisonCache.keys().next().value);
  }
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fetchGeminiWithRetry = async ({ model, retryModel, makeUrl, options, log }) => {
  let lastNetworkError;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
    const attemptModel = attempt === 0 || !retryModel ? model : retryModel;
    try {
      const response = await fetch(makeUrl(attemptModel), options);
      if (response.status !== 503 || attempt === GEMINI_RETRY_DELAYS_MS.length) {
        return { response, attemptCount: attempt + 1, model: attemptModel };
      }
      const delay = GEMINI_RETRY_DELAYS_MS[attempt];
      const nextModel = retryModel || model;
      log(`Gemini ${attemptModel} está temporalmente saturado (HTTP 503). Reintentaremos con ${nextModel} en ${Math.round(delay / 1000)} s (${attempt + 1}/${GEMINI_RETRY_DELAYS_MS.length}).`);
      await response.body?.cancel();
      await wait(delay);
    } catch (error) {
      lastNetworkError = error;
      if (attempt === GEMINI_RETRY_DELAYS_MS.length) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { geminiAttemptCount: attempt + 1 });
      }
      const delay = GEMINI_RETRY_DELAYS_MS[attempt];
      const nextModel = retryModel || model;
      log(`No se ha podido contactar con Gemini ${attemptModel}. Reintentaremos con ${nextModel} en ${Math.round(delay / 1000)} s (${attempt + 1}/${GEMINI_RETRY_DELAYS_MS.length}).`);
      await wait(delay);
    }
  }
  throw lastNetworkError || new Error('Gemini no ha respondido tras varios intentos.');
};
const normalizedText = (value = '') => value.trim().toLocaleLowerCase('es');
const normalizedWord = (value = '') => value.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const COLOR_WORD_ALIASES = {
  beis: 'beige', beises: 'beige', beiges: 'beige',
  blanca: 'blanco', blancas: 'blanco', blancos: 'blanco',
  negra: 'negro', negras: 'negro', negros: 'negro',
  roja: 'rojo', rojas: 'rojo', rojos: 'rojo',
  amarilla: 'amarillo', amarillas: 'amarillo', amarillos: 'amarillo',
  morada: 'morado', moradas: 'morado', morados: 'morado',
  dorada: 'dorado', doradas: 'dorado', dorados: 'dorado',
  plateada: 'plateado', plateadas: 'plateado', plateados: 'plateado',
  rosada: 'rosa', rosadas: 'rosa', rosado: 'rosa', rosados: 'rosa', rosas: 'rosa',
  marron: 'marrón', marrones: 'marrón', cafe: 'marrón', cafes: 'marrón',
  azules: 'azul', verdes: 'verde', grises: 'gris', naranjas: 'naranja',
  violetas: 'violeta', lilas: 'lila', turquesas: 'turquesa', granates: 'granate',
  cremas: 'crema', marfiles: 'marfil', ocres: 'ocre', olivas: 'oliva',
  corales: 'coral', mostazas: 'mostaza', terracotas: 'terracota',
  salmon: 'salmón', salmones: 'salmón', aguamarinas: 'aguamarina',
  cobriza: 'cobrizo', cobrizas: 'cobrizo', cobrizos: 'cobrizo',
  purpura: 'morado', purpuras: 'morado', purple: 'morado',
  cyan: 'cian', borgona: 'burdeos', burgundy: 'burdeos',
  kakis: 'caqui', kaki: 'caqui', khaki: 'caqui', khakis: 'caqui', caquis: 'caqui',
  fuchsia: 'fucsia', fuchsias: 'fucsia', fucsias: 'fucsia',
  grey: 'gris', gray: 'gris', navy: 'azul marino',
};
const canonicalColor = (value = '') => typeof value === 'string'
  ? value.trim().toLocaleLowerCase('es').replace(/[\p{L}]+/gu, (word) => COLOR_WORD_ALIASES[normalizedWord(word)] || word)
  : '';
const normalizeGarmentColors = (item) => ({
  ...item,
  primaryColor: canonicalColor(item.primaryColor),
  secondaryColors: (item.secondaryColors || []).map(canonicalColor),
});
const isFootwear = (item) => {
  const description = `${normalizedText(item.category)} ${normalizedText(item.subcategory)}`;
  return ['calzado', 'zapatill', 'zapato', 'bota', 'sandalia', 'mocasin', 'mocasín', 'tacon', 'tacón'].some((term) => description.includes(term));
};
const isExcludedWardrobeItem = (item) => {
  const description = normalizedText(`${item.category || ''} ${item.subcategory || ''}`);
  return [
    'auricular', 'audifono', 'audífono', 'headphone', 'earphone', 'earbud', 'airpod', 'cascos de audio',
    'gafas', 'anteojos', 'lentes', 'glasses', 'sunglasses', 'eyewear',
  ].some((term) => description.includes(term));
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
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const retryModel = process.env.GEMINI_FALLBACK_MODEL === undefined
    ? 'gemini-3.1-flash-lite'
    : process.env.GEMINI_FALLBACK_MODEL.trim();
  let effectiveModel = model;
  let fallbackUsed = false;
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || 'minimal';
  let providerDurationMs = 0;
  let providerAttemptCount = 0;
  let cacheHit = false;
  let savedBytes = null;
  const log = (message) => console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);
  const comparisonMeta = () => ({
    requestId,
    model: effectiveModel,
    fallbackUsed,
    serverDurationMs: Date.now() - startedAt,
    providerDurationMs,
    providerAttemptCount,
    cacheHit,
    candidateBytes: request.files?.candidate?.[0]?.size || null,
    savedBytes,
  });
  const candidate = request.files?.candidate?.[0];
  const legacySavedImage = request.files?.saved?.[0];
  const savedGarmentId = request.body?.savedGarmentId;
  if (!candidate || (!savedGarmentId && !legacySavedImage)) return response.status(400).json({ error: 'Faltan la foto nueva o la prenda guardada.', _analysisMeta: comparisonMeta() });
  if (!process.env.GEMINI_API_KEY) return response.status(503).json({ error: 'El servidor no tiene configurada GEMINI_API_KEY.', _analysisMeta: comparisonMeta() });

  try {
    let supabase = null;
    let savedGarment = null;
    let savedBuffer;
    let savedMimeType;
    if (savedGarmentId) {
      supabase = requestSupabaseClient(request);
      const { data, error: savedGarmentError } = await supabase
        .from('garments')
        .select('id, user_id, image_path')
        .eq('id', savedGarmentId)
        .maybeSingle();
      if (savedGarmentError || !data) {
        throw Object.assign(new Error('La prenda guardada no existe o no pertenece al usuario.'), { status: 404 });
      }
      savedGarment = data;
      const { data: savedImage, error: savedImageError } = await supabase.storage
        .from('garment-images')
        .download(savedGarment.image_path);
      if (savedImageError || !savedImage) {
        throw Object.assign(new Error('No se ha podido descargar la foto guardada.'), { status: 502 });
      }
      savedBuffer = Buffer.from(await savedImage.arrayBuffer());
      savedMimeType = savedImage.type || 'image/jpeg';
    } else {
      savedBuffer = legacySavedImage.buffer;
      savedMimeType = legacySavedImage.mimetype;
      log('Comparación recibida con el formato anterior; se omite la caché persistente.');
    }
    savedBytes = savedBuffer.byteLength;
    const [candidateHash, savedHash] = await Promise.all([
      perceptualImageHash(candidate.buffer),
      perceptualImageHash(savedBuffer),
    ]);
    const candidateDigest = imageDigest(candidate.buffer);
    const savedDigest = imageDigest(savedBuffer);
    const cacheIdentity = { candidateHash, savedHash, candidateDigest, savedDigest, model, retryModel, thinkingLevel };
    const cacheScope = savedGarment?.user_id || 'legacy';
    const cacheKey = `${cacheScope}:${model}:${retryModel}:${thinkingLevel}:${COMPARISON_PROMPT_VERSION}:${candidateDigest}:${savedDigest}`;
    const cachedComparison = readComparisonCache(cacheKey);
    if (cachedComparison) {
      cacheHit = true;
      log('Comparación recuperada de caché en memoria.');
      return response.json({ ...cachedComparison, _analysisMeta: comparisonMeta() });
    }
    const persistedComparison = supabase ? await readPersistentComparisonCache(supabase, cacheIdentity, log) : null;
    if (persistedComparison) {
      cacheHit = true;
      writeComparisonCache(cacheKey, persistedComparison);
      log('Comparación recuperada de caché persistente.');
      return response.json({ ...persistedComparison, _analysisMeta: comparisonMeta() });
    }
    log(`Fotos de comparación recibidas: nueva ${(candidate.size / 1024).toFixed(0)} KB, guardada ${(savedBytes / 1024).toFixed(0)} KB.`);
    log(`Comparando visualmente dos prendas con Gemini (${model})…`);
    const geminiStartedAt = Date.now();
    const waitingLog = setInterval(() => log(`Gemini sigue comparando las prendas… ${Math.round((Date.now() - geminiStartedAt) / 1000)} s de espera.`), 5000);
    let geminiResponse;
    try {
      const geminiResult = await fetchGeminiWithRetry({
      model,
      retryModel,
      makeUrl: (modelName) => `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: 'Compara estas dos fotos recortadas de prendas. Determina si probablemente muestran exactamente la misma prenda física, aunque cambien la pose, iluminación, escala u oclusión. No basta con que sean del mismo tipo y color: busca coincidencias en corte, costuras, estampado, logotipo, tipo de tejido, textura y detalles distintivos. Da prioridad a la construcción y apariencia visible del tejido; no intentes deducir su composición de fibras. La primera imagen es la nueva y la segunda ya está en el armario. Indica también en bestImage cuál es mejor como foto principal de armario: candidate si la nueva muestra la prenda con más nitidez, tamaño, integridad y menos oclusiones; saved si la guardada es mejor.' },
          { text: 'IMAGEN NUEVA' },
          { inlineData: { mimeType: candidate.mimetype, data: candidate.buffer.toString('base64') } },
          { text: 'IMAGEN GUARDADA' },
          { inlineData: { mimeType: savedMimeType, data: savedBuffer.toString('base64') } },
        ] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel },
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
      geminiResponse = geminiResult.response;
      providerAttemptCount = geminiResult.attemptCount;
      effectiveModel = geminiResult.model;
      fallbackUsed = effectiveModel !== model;
    } finally {
      clearInterval(waitingLog);
      providerDurationMs = Date.now() - geminiStartedAt;
    }
    log(`Gemini ${effectiveModel} ha respondido a la comparación con HTTP ${geminiResponse.status} tras ${Date.now() - geminiStartedAt} ms.`);
    const result = await geminiResponse.json();
    if (!geminiResponse.ok) throw Object.assign(new Error(result?.error?.message || 'Error de Gemini'), { status: geminiResponse.status });
    const outputText = result?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!outputText) throw new Error('Gemini no devolvió una comparación utilizable.');
    const comparison = JSON.parse(outputText);
    writeComparisonCache(cacheKey, comparison);
    if (supabase && savedGarment) {
      void writePersistentComparisonCache(supabase, cacheIdentity, comparison, savedGarment.user_id, savedGarment.id, log);
    }
    log(`Comparación completada en ${Date.now() - startedAt} ms: ${comparison.sameGarment ? 'posible duplicado' : 'prendas distintas'} (${Math.round(comparison.confidence * 100)}%).`);
    response.json({ ...comparison, _analysisMeta: comparisonMeta() });
  } catch (error) {
    providerAttemptCount = error?.geminiAttemptCount || providerAttemptCount;
    console.error(`[${new Date().toISOString()}] [${requestId}] Error comparando prendas:`, error?.message || error);
    const status = error?.status || 502;
    const message = error?.status ? error.message : 'No se han podido comparar visualmente las prendas.';
    response.status(status).json({ error: message, _analysisMeta: comparisonMeta() });
  }
});

app.post('/analyze-outfit', upload.single('photo'), async (request, response) => {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL === undefined
    ? 'gemini-3.1-flash-lite'
    : process.env.GEMINI_FALLBACK_MODEL.trim();
  let effectiveModel = model;
  let fallbackUsed = false;
  let providerStartedAt;
  let providerDurationMs;
  let providerAttemptCount = 0;
  let postprocessStartedAt;
  let postprocessDurationMs;
  const requestedOccasion = OUTFIT_OCCASIONS.has(request.body?.occasion) ? request.body.occasion : NO_SPECIFIC_OCCASION;
  const requestedStyleGoal = LEGACY_OUTFIT_STYLE_GOALS.has(request.body?.styleGoal) ? request.body.styleGoal : null;
  const log = (message) => console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);
  const analysisMeta = () => ({
    requestId,
    model: effectiveModel,
    fallbackUsed,
    occasion: requestedOccasion,
    styleGoal: requestedStyleGoal,
    serverDurationMs: Date.now() - startedAt,
    providerDurationMs: providerDurationMs
      ?? (providerStartedAt ? Date.now() - providerStartedAt : null),
    providerAttemptCount,
    postprocessDurationMs: postprocessDurationMs
      ?? (postprocessStartedAt ? Date.now() - postprocessStartedAt : null),
    imageBytes: request.file?.size || null,
  });
  const sendError = (status, error) => response.status(status).json({ error, _analysisMeta: analysisMeta() });

  log('Nueva solicitud de análisis.');
  if (!request.file) {
    log('Solicitud rechazada: no contiene una foto.');
    return sendError(400, 'Falta la foto.');
  }
  log(`Foto recibida: ${request.file.mimetype}, ${(request.file.size / 1024 / 1024).toFixed(2)} MB.`);
  log(requestedOccasion !== NO_SPECIFIC_OCCASION
    ? `Ocasión indicada: ${requestedOccasion}.`
    : requestedStyleGoal
      ? `Objetivo de estilo de una versión anterior de la app: ${requestedStyleGoal}.`
      : 'No se ha indicado una ocasión concreta.');

  if (!process.env.GEMINI_API_KEY) {
    log('Solicitud rechazada: GEMINI_API_KEY no está configurada.');
    return sendError(503, 'El servidor no tiene configurada GEMINI_API_KEY.');
  }

  try {
    log(`Enviando la imagen a Gemini (${model})…`);
    const geminiStartedAt = Date.now();
    providerStartedAt = geminiStartedAt;
    const waitingLog = setInterval(() => {
      const waitingSeconds = Math.round((Date.now() - geminiStartedAt) / 1000);
      log(`Gemini sigue procesando la imagen… ${waitingSeconds} s de espera.`);
    }, 5000);
    let geminiResponse;
    try {
      const requestGemini = (modelName) => fetchGeminiWithRetry({
      model: modelName,
      retryModel: fallbackModel,
      makeUrl: (attemptModel) => `https://generativelanguage.googleapis.com/v1beta/models/${attemptModel}:generateContent`,
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
            { text: 'No incluyas gafas, gafas de sol, anteojos, lentes ni ningún tipo de eyewear entre las prendas o accesorios. Tampoco incluyas auriculares, cascos de audio, earbuds, AirPods ni ningún otro dispositivo de sonido.' },
            { text: 'Prioriza la identificación del tipo o construcción visible del tejido en fabricType (por ejemplo punto, tejido plano, denim, pana, cuero, encaje o tejido técnico) y su textura. La composición de fibras en materialEstimate es secundaria y rara vez puede saberse por una foto: no dediques esfuerzo a adivinarla; si no hay evidencia visual clara devuelve “no determinable” o una estimación prudente con materialConfidence baja.' },
            { text: 'No tengas en cuenta bebés ni niños muy pequeños: no los devuelvas como personas seleccionables, no enumeres sus prendas y no confundas su ropa o accesorios con los de los adultos que aparecen en la foto. Si hay al menos uno claramente visible, establece youngChildDetected en true; úsalo únicamente como señal de exclusión, sin estimar edades ni describir al menor.' },
            { text: requestedOccasion !== NO_SPECIFIC_OCCASION
              ? `El usuario quiere usar este outfit para: ${requestedOccasion}. Evalúalo específicamente para ese contexto, atendiendo a su coherencia visual, nivel de formalidad, acabado y adecuación estilística. No inventes un código de vestimenta que el usuario no haya indicado. Si puede funcionar mejor para esa ocasión, propón cambios estéticos concretos y visibles.`
              : requestedStyleGoal
                ? `El usuario busca un resultado de estilo ${requestedStyleGoal}. Evalúa el outfit específicamente respecto a ese objetivo: valora si silueta, proporciones, paleta, prendas, tejidos y acabados son coherentes con ${requestedStyleGoal}. No lo penalices por no responder a otros estilos; si no encaja, explica qué cambios estéticos visibles lo acercarían a ${requestedStyleGoal}.`
                : 'El usuario no busca una ocasión concreta. Evalúa el outfit de forma general, basándote en su coherencia visual, y no presupongas un contexto de uso.' },
            { text: 'En la valoración del outfit usa un criterio positivo y ligeramente más generoso: un conjunto bien coordinado y apropiado puede estar en 80-89; reserva 90-94 para conjuntos especialmente logrados y 95-100 solo para resultados excepcionales. Usa notas inferiores a 70 únicamente si hay problemas visuales claros y relevantes.' },
            { text: 'Detecta las personas visibles y valora para cada una foregroundSubject y prominence entre 0 y 1. Ordénalas de izquierda a derecha y asigna ids consecutivos empezando por 1. Describe su posición brevemente sin usar rasgos personales. Indica si su cara es visible y devuelve faceBox con xMin, yMin, xMax e yMax entre 0 y 1000; si no es visible usa ceros. Para cada persona enumera las prendas y accesorios que lleva y genera outfitEvaluation: una valoración breve y amable basada solo en lo visible del conjunto (coordinación de colores, equilibrio, ocasión y acabado), con score de 0 a 100, summary, detectedStyles con 1-3 estilos estéticos reconocibles del conjunto, 1-3 strengths, 1-3 improvements y 1-3 suggestions accionables de vestimenta que harían que el conjunto combinase o se viera mejor. Usa nombres de estilo claros y habituales en español, sin deducir rasgos personales. Usa una escala exigente y amplia: 50-59 es un conjunto correcto pero con varios aspectos visuales mejorables; 60-69 es bueno; 70-79 muy bueno; 80-89 excelente y coherente; 90-94 sobresaliente; reserva 95-100 para estilismos excepcionales, impecables y especialmente memorables. No concentres las puntuaciones entre 80 y 88: penaliza de forma proporcionada incompatibilidades de color, proporción, formalidad, acabado o falta de intención estilística. Las mejoras deben ser exclusivamente estéticas y de styling: no recomiendes prendas por el clima, comodidad, protección, utilidad, seguridad ni planes hipotéticos (por ejemplo, no sugieras añadir una chaqueta por si cambia el tiempo). No juzgues el cuerpo, atractivo, género, edad ni rasgos personales, y no inventes prendas que no se vean. Para cada prenda devuelve itemBox, un rectángulo lo más ajustado posible con xMin, yMin, xMax e yMax entre 0 y 1000. Incluye categoría, subcategoría, color principal, colores secundarios, estilos, estampado, marca claramente visible en brand (o cadena vacía), composición aparente en materialEstimate, tipo de construcción en fabricType, textura visible en texture, confianza específica del material entre 0 y 1 y confianza general entre 0 y 1. En el color sé preciso y descriptivo. Usa nombres canónicos en español, en singular y forma base: “beige” (no “beis”), “marrón” (no “café”), “rosa” (no “rosado”), “caqui” (no “kaki” ni “khaki”) y “fucsia” (no “fuchsia”). Conserva matices como claro, oscuro, pastel o marino. El color principal debe incluir la combinación cuando la prenda tenga varios colores visibles (por ejemplo, “blanco y negro” para una camisa de rayas blancas y negras), colores secundarios debe listar todos los colores claramente apreciables y su orden no importa. No uses solo el color dominante ni omitas rayas, cuadros, bloques o estampados bicolor; si un color ocupa una parte relevante, inclúyelo aunque sea secundario.' },
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
                        detectedStyles: { type: 'array', items: { type: 'string' } },
                        strengths: { type: 'array', items: { type: 'string' } },
                        improvements: { type: 'array', items: { type: 'string' } },
                        suggestions: { type: 'array', items: { type: 'string' } },
                      }, required: ['score', 'summary', 'detectedStyles', 'strengths', 'improvements', 'suggestions'],
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
                          materialEstimate: { type: 'string', description: 'Composición aparente secundaria; usa no determinable cuando no haya evidencia visual suficiente.' },
                          fabricType: { type: 'string', description: 'Dato prioritario: construcción o tipo visible del tejido, no composición de fibras.' },
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
      const callModel = async (modelName) => {
        try {
          const result = await requestGemini(modelName);
          providerAttemptCount += result.attemptCount;
          return result;
        } catch (error) {
          providerAttemptCount += error?.geminiAttemptCount || 0;
          if (error && typeof error === 'object') error.geminiAttemptCount = providerAttemptCount;
          throw error;
        }
      };
      let geminiResult = await callModel(model);
      effectiveModel = geminiResult.model;
      fallbackUsed = effectiveModel !== model;
      const fallbackStatuses = new Set([404, 429, 500, 502, 503, 504]);
      if (!geminiResult.response.ok && fallbackStatuses.has(geminiResult.response.status) && fallbackModel && effectiveModel !== fallbackModel) {
        const primaryStatus = geminiResult.response.status;
        await geminiResult.response.body?.cancel();
        fallbackUsed = true;
        effectiveModel = fallbackModel;
        log(`El modelo principal ha devuelto HTTP ${primaryStatus}. Activando fallback (${fallbackModel})…`);
        geminiResult = await callModel(fallbackModel);
        effectiveModel = geminiResult.model;
      }
      geminiResponse = geminiResult.response;
    } finally {
      clearInterval(waitingLog);
      providerDurationMs = Date.now() - geminiStartedAt;
    }

    log(`Cabeceras recibidas de Gemini ${effectiveModel}: HTTP ${geminiResponse.status} tras ${Date.now() - geminiStartedAt} ms.`);
    const responseBodyStartedAt = Date.now();
    const result = await geminiResponse.json();
    providerDurationMs = Date.now() - geminiStartedAt;
    postprocessStartedAt = Date.now();
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
    let excludedItemCount = 0;
    analysis.people = analysis.people.map((person) => {
      const originalCount = person.items?.length || 0;
      const wardrobeItems = (person.items || [])
        .filter((item) => !isExcludedWardrobeItem(item))
        .map(normalizeGarmentColors);
      excludedItemCount += originalCount - wardrobeItems.length;
      const items = mergeFootwearPairs(wardrobeItems);
      mergedFootwearCount += wardrobeItems.length - items.length;
      return { ...person, items };
    });
    if (excludedItemCount > 0) log(`${excludedItemCount} elementos excluidos del armario (gafas o dispositivos de audio).`);
    if (mergedFootwearCount > 0) log(`${mergedFootwearCount} duplicados de calzado fusionados como pares.`);
    const garmentCount = analysis.people?.reduce((total, person) => total + (person.items?.length || 0), 0) || 0;
    postprocessDurationMs = Date.now() - postprocessStartedAt;
    log(`Análisis completado: ${analysis.people?.length || 0} personas y ${garmentCount} prendas detectadas en ${Date.now() - startedAt} ms.`);
    response.json({ ...analysis, _analysisMeta: analysisMeta() });
  } catch (error) {
    providerAttemptCount = error?.geminiAttemptCount || providerAttemptCount;
    console.error(`[${new Date().toISOString()}] [${requestId}] Error tras ${Date.now() - startedAt} ms:`, error?.message || error);
    if (error?.status === 503) {
      return sendError(503, 'Gemini está temporalmente saturado. Hemos reintentado el análisis varias veces; prueba de nuevo en un momento.');
    }
    if (error?.status === 429) {
      return sendError(429, 'Has alcanzado temporalmente el límite gratuito de Gemini. Espera un poco y vuelve a intentarlo.');
    }
    if (error?.status === 404) {
      return sendError(502, 'El modelo de análisis ya no está disponible. Actualiza GEMINI_MODEL en el servidor.');
    }
    if (error?.status === 422) {
      return sendError(422, error.message);
    }
    sendError(502, 'No se ha podido analizar la imagen.');
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
