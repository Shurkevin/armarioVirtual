import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  Linking as NativeLinking,
  Modal,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { makeRedirectUri } from 'expo-auth-session';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './lib/supabase';
import type { DatabaseGarmentRow, DatabaseOutfitRow } from './lib/supabase';

WebBrowser.maybeCompleteAuthSession();

type Tab = 'inicio' | 'armario' | 'outfits' | 'captura' | 'compras' | 'perfil';
type AddStage = 'upload' | 'person' | 'review' | 'duplicates';
type Garment = {
  customName?: string;
  category: string;
  subcategory: string;
  primaryColor: string;
  secondaryColors: string[];
  styles: string[];
  pattern: string;
  brand: string;
  materialEstimate: string;
  fabricType: string;
  texture: string;
  materialConfidence: number;
  confidence: number;
  itemBox: FaceBox;
  displayRotation: number;
};
type FaceBox = { xMin: number; yMin: number; xMax: number; yMax: number };
type OutfitEvaluation = { score: number; summary: string; strengths: string[]; improvements: string[]; suggestions: string[] };
type PersonAnalysis = { id: number; position: string; faceVisible: boolean; faceBox: FaceBox; items: Garment[]; outfitEvaluation?: OutfitEvaluation };
type AnalysisMeta = {
  requestId?: string;
  model?: string;
  serverDurationMs?: number;
  providerDurationMs?: number | null;
  providerAttemptCount?: number;
  postprocessDurationMs?: number | null;
  imageBytes?: number | null;
  cacheHit?: boolean;
  candidateBytes?: number | null;
  savedBytes?: number | null;
};
type GarmentComparison = { sameGarment: boolean; confidence: number; reason: string; bestImage: 'candidate' | 'saved'; _analysisMeta?: AnalysisMeta; clientDurationMs: number; httpStatus: number };
type GarmentFingerprint = Pick<Garment, 'category' | 'subcategory' | 'primaryColor' | 'brand' | 'pattern' | 'fabricType' | 'styles'>;
type SavedGarment = Garment & { id: string; imageUri: string; storagePath?: string; wearCount: number; scanFingerprint?: GarmentFingerprint } & Record<string, any>;
type DuplicateMatch = { candidateId: string; candidate: SavedGarment; saved: SavedGarment; bestImage: 'candidate' | 'saved' };
type OutfitDraft = { imageUri: string; evaluation: OutfitEvaluation | null; createdAt: string };
type DuplicateReview = { croppedItems: SavedGarment[]; appearanceItems: SavedGarment[]; matchedGarmentIds: Record<string, string>; outfit: OutfitDraft; matches: DuplicateMatch[]; wornItemIds: string[]; updatedItems: SavedGarment[] };
type SavedOutfit = { id: string; imageUri: string; storagePath?: string; garments: SavedGarment[]; evaluation: OutfitEvaluation | null; createdAt: string };
type NoticeAction = { label: string; onPress?: () => void; destructive?: boolean };
type Notice = { title: string; message: string; actions?: NoticeAction[] };
const NoticeContext = createContext<{ showNotice: (notice: Notice) => void }>({ showNotice: () => undefined });
const useNotice = () => useContext(NoticeContext);
const recordAnalysisRun = (metrics: Record<string, unknown>) => {
  void Promise.resolve(supabase.from('analysis_runs').insert(metrics)).then(({ error }) => {
    if (error) console.warn('[Supabase] No se pudieron guardar las métricas del análisis:', error.message);
  }).catch((error: unknown) => {
    console.warn('[Supabase] Fallo de red al guardar las métricas del análisis:', error);
  });
};
const mapWithConcurrency = async <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

const AI_IMAGE_MAX_DIMENSION = 1280;
const AI_IMAGE_JPEG_QUALITY = 0.82;
const prepareImageForAi = async (uri: string, knownSize?: { width: number; height: number } | null) => {
  let width = knownSize?.width || 0;
  let height = knownSize?.height || 0;
  if (!width || !height) {
    [width, height] = await new Promise<[number, number]>((resolve, reject) => {
      Image.getSize(uri, (resolvedWidth, resolvedHeight) => resolve([resolvedWidth, resolvedHeight]), reject);
    });
  }
  const resize = Math.max(width, height) > AI_IMAGE_MAX_DIMENSION
    ? width >= height ? { width: AI_IMAGE_MAX_DIMENSION } : { height: AI_IMAGE_MAX_DIMENSION }
    : null;
  return ImageManipulator.manipulateAsync(
    uri,
    resize ? [{ resize }] : [],
    { compress: AI_IMAGE_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );
};

const COLORS = {
  ink: '#201D1A', muted: '#7C7771', paper: '#F7F4EF', white: '#FFFFFF',
  sage: '#C8D1BD', sageDark: '#50614A', clay: '#D98567', sand: '#E8DED0', line: '#E8E2DA',
};

const nav: { key: Tab; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: 'inicio', label: 'Inicio', icon: 'home' },
  { key: 'armario', label: 'Armario', icon: 'grid' },
  { key: 'captura', label: 'Añadir', icon: 'plus' },
  { key: 'outfits', label: 'Outfits', icon: 'layers' },
  { key: 'compras', label: 'Compras', icon: 'shopping-bag' },
];
const FIXED_CATEGORIES = ['ropa superior', 'ropa inferior', 'prenda de cuerpo entero', 'abrigo', 'calzado', 'accesorio'];
const FIXED_TYPES = ['camiseta', 'camisa', 'polo', 'sudadera', 'suéter', 'jersey', 'chaqueta', 'abrigo', 'pantalón', 'vaquero', 'falda', 'vestido', 'short', 'zapatillas', 'zapatos', 'botas', 'sandalias', 'reloj', 'bolso', 'gorra', 'bufanda', 'cinturón'];
const FIXED_TYPES_BY_CATEGORY: Record<string, string[]> = {
  'ropa superior': ['camiseta', 'camisa', 'polo', 'sudadera', 'suéter', 'jersey', 'chaqueta'],
  'ropa inferior': ['pantalón', 'vaquero', 'falda', 'short'],
  'prenda de cuerpo entero': ['vestido', 'mono'],
  abrigo: ['abrigo', 'chaqueta', 'parka', 'gabardina'],
  calzado: ['zapatillas', 'zapatos', 'botas', 'sandalias'],
  accesorio: ['reloj', 'bolso', 'gorra', 'bufanda', 'cinturón'],
};
const typesForCategory = (category: string) => FIXED_TYPES_BY_CATEGORY[normalizedValue(category)] || FIXED_TYPES;
const parsePhotoDate = (value: string | number) => {
  if (typeof value === 'number') return new Date(value).toISOString();
  const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const garmentTitle = (item: Garment) => {
  if (item.customName?.trim()) return item.customName.trim();
  const type = (item.subcategory || item.category || 'prenda').trim();
  const firstWord = type.toLocaleLowerCase('es').split(/\s+/)[0];
  const feminineGarments = new Set(['blusa', 'bota', 'bufanda', 'camisa', 'camiseta', 'chaqueta', 'corbata', 'falda', 'gorra', 'prenda', 'ropa', 'sudadera', 'zapatilla']);
  const feminineColors: Record<string, string> = {
    blanco: 'blanca', negro: 'negra', rojo: 'roja', amarillo: 'amarilla', morado: 'morada',
    dorado: 'dorada', plateado: 'plateada', rosado: 'rosada', beige: 'beige',
  };
  const colorWords = (item.primaryColor || '').trim().toLocaleLowerCase('es').split(/\s+/).filter(Boolean);
  const pluralGarment = firstWord.endsWith('s');
  const singularFirstWord = pluralGarment ? firstWord.slice(0, -1) : firstWord;
  if (feminineGarments.has(singularFirstWord) && colorWords[0]) {
    const masculineColor = colorWords[0].replace(/os$/, 'o');
    const feminineColor = feminineColors[masculineColor] || colorWords[0];
    colorWords[0] = pluralGarment && feminineColor.endsWith('a') ? `${feminineColor}s` : feminineColor;
  }
  const words = [type, item.brand?.trim(), colorWords.join(' ')].filter(Boolean);
  const title = words.join(' ');
  return title.charAt(0).toLocaleUpperCase('es') + title.slice(1);
};

const normalizedCategory = (category: string) => {
  const raw = (category || 'Sin categoría').trim();
  const comparable = raw.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const aliases: Record<string, { key: string; label: string }> = {
    superior: { key: 'ropa-superior', label: 'Ropa superior' },
    'ropa superior': { key: 'ropa-superior', label: 'Ropa superior' },
    'parte superior': { key: 'ropa-superior', label: 'Ropa superior' },
    'prenda superior': { key: 'ropa-superior', label: 'Ropa superior' },
    inferior: { key: 'ropa-inferior', label: 'Ropa inferior' },
    'ropa inferior': { key: 'ropa-inferior', label: 'Ropa inferior' },
    'parte inferior': { key: 'ropa-inferior', label: 'Ropa inferior' },
    'prenda inferior': { key: 'ropa-inferior', label: 'Ropa inferior' },
  };
  return aliases[comparable] || { key: comparable.replace(/\s+/g, '-'), label: raw };
};

const normalizedValue = (value = '') => value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const COLOR_WORD_ALIASES: Record<string, string> = {
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
const canonicalColor = (value = '') => value.trim().toLocaleLowerCase('es').replace(/[\p{L}]+/gu, (word) => COLOR_WORD_ALIASES[normalizedValue(word)] || word);
const normalizedColorValue = (value = '') => normalizedValue(canonicalColor(value));
const canonicalizeGarmentColors = (item: Garment): Garment => ({
  ...item,
  primaryColor: canonicalColor(item.primaryColor),
  secondaryColors: (item.secondaryColors || []).map(canonicalColor),
});
const colorFamily = (value = '') => {
  const color = normalizedColorValue(value);
  const families: [string, string[]][] = [
    ['blanco', ['blanco', 'blanca', 'blancos', 'blancas', 'blanco roto', 'blanca rota', 'crudo', 'cruda', 'marfil', 'crema']],
    ['negro', ['negro', 'negra', 'negros', 'negras', 'antracita']],
    ['rojo', ['rojo', 'roja', 'rojos', 'rojas', 'granate', 'burdeos']],
    ['azul', ['azul', 'azul marino', 'celeste']],
    ['marron', ['marron', 'marrones', 'camel', 'cafe']],
  ];
  return families.find(([, variants]) => variants.some((variant) => color === variant || color.startsWith(`${variant} `)))?.[0] || color;
};
const colorFamilies = (item: Pick<Garment, 'primaryColor'> & { secondaryColors?: string[] }) => new Set([item.primaryColor, ...(item.secondaryColors || [])].filter(Boolean).map((color) => colorFamily(color)));
const garmentKind = (item: Pick<Garment, 'category' | 'subcategory'>) => {
  const description = normalizedValue(`${item.subcategory} ${item.category}`);
  return ['camiseta', 'camisa', 'sudadera', 'sueter', 'jersey', 'pantalon', 'vaquero', 'falda', 'vestido', 'chaqueta', 'abrigo', 'zapatilla', 'zapato', 'bota', 'sandalia']
    .find((kind) => description.includes(kind)) || normalizedValue(item.subcategory || item.category);
};
const duplicateScore = (candidate: Garment, saved: SavedGarment) => {
  const savedIdentity = saved.scanFingerprint || saved;
  let score = 0;
  const exactType = normalizedValue(candidate.subcategory || candidate.category) === normalizedValue(savedIdentity.subcategory || savedIdentity.category);
  if (exactType) score += 0.4;
  else if (garmentKind(candidate) === garmentKind(savedIdentity)) score += 0.3;
  if (normalizedCategory(candidate.category).key === normalizedCategory(savedIdentity.category).key) score += 0.15;
  if (normalizedColorValue(candidate.primaryColor) === normalizedColorValue(savedIdentity.primaryColor)) score += 0.2;
  else if (colorFamily(candidate.primaryColor) === colorFamily(savedIdentity.primaryColor)) score += 0.15;
  const candidateColors = colorFamilies(candidate);
  const savedColors = colorFamilies(savedIdentity);
  if ([...candidateColors].some((color) => savedColors.has(color))) score += 0.12;
  if (candidateColors.size > 1 && savedColors.size === 1) score -= 0.04;
  if (normalizedValue(candidate.pattern) === normalizedValue(savedIdentity.pattern)) score += 0.1;
  const candidateFabricType = normalizedValue(candidate.fabricType);
  const savedFabricType = normalizedValue(savedIdentity.fabricType);
  if (candidateFabricType && savedFabricType) score += candidateFabricType === savedFabricType ? 0.1 : -0.05;
  const candidateBrand = normalizedValue(candidate.brand);
  const savedBrand = normalizedValue(savedIdentity.brand);
  if (candidateBrand && savedBrand) score += candidateBrand === savedBrand ? 0.15 : -0.2;
  const savedStyles = new Set(savedIdentity.styles.map(normalizedValue));
  if (candidate.styles.some((style) => savedStyles.has(normalizedValue(style)))) score += 0.1;
  return score;
};
const hasUsefulValue = (value = '') => {
  const normalized = normalizedValue(value);
  return Boolean(normalized) && !['no determinable', 'desconocido', 'desconocida', 'sin determinar', 'no identificado', 'no identificada', 'n/a'].includes(normalized);
};
const keepBestValue = (savedValue: string, candidateValue: string) => hasUsefulValue(savedValue) ? savedValue : candidateValue;
const unionValues = (first: string[], second: string[]) => Array.from(new Map([...first, ...second].filter(Boolean).map((value) => [normalizedValue(value), value])).values());
const unionColors = (first: string[], second: string[]) => Array.from(new Map([...first, ...second]
  .filter(Boolean)
  .map((value) => [normalizedColorValue(value), canonicalColor(value)])).values());
const mergeScans = (saved: SavedGarment, candidate: SavedGarment, bestImage: 'candidate' | 'saved'): SavedGarment => {
  const bestPhoto = bestImage === 'candidate' ? candidate : saved;
  return {
    ...saved,
    category: keepBestValue(saved.category, candidate.category),
    subcategory: keepBestValue(saved.subcategory, candidate.subcategory),
    primaryColor: canonicalColor(keepBestValue(saved.primaryColor, candidate.primaryColor)),
    secondaryColors: unionColors(saved.secondaryColors, [candidate.primaryColor, ...candidate.secondaryColors].filter((color) => normalizedColorValue(color) !== normalizedColorValue(saved.primaryColor))),
    styles: unionValues(saved.styles, candidate.styles),
    pattern: keepBestValue(saved.pattern, candidate.pattern),
    brand: keepBestValue(saved.brand, candidate.brand),
    materialEstimate: keepBestValue(saved.materialEstimate, candidate.materialEstimate),
    fabricType: keepBestValue(saved.fabricType, candidate.fabricType),
    texture: keepBestValue(saved.texture, candidate.texture),
    materialConfidence: Math.max(saved.materialConfidence, candidate.materialConfidence),
    confidence: Math.max(saved.confidence, candidate.confidence),
    imageUri: bestPhoto.imageUri,
    itemBox: bestPhoto.itemBox,
    displayRotation: bestPhoto.displayRotation,
    scanFingerprint: saved.scanFingerprint || candidate.scanFingerprint,
  };
};

const GARMENT_BUCKET = 'garment-images';
const OUTFIT_BUCKET = 'outfit-images';
const toStringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const isLocalImage = (uri: string) => uri.startsWith('file:') || uri.startsWith('content:');

const uploadGarmentImage = async (userId: string, uri: string, existingPath?: string) => {
  const file = new File(uri);
  const content = await file.arrayBuffer();
  if (!content.byteLength) throw new Error('No hemos podido leer la foto de la prenda.');
  const path = existingPath || `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const { error } = await supabase.storage.from(GARMENT_BUCKET).upload(path, content, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: Boolean(existingPath),
  });
  if (error) throw new Error(`No hemos podido subir la foto: ${error.message}`);
  return path;
};

const signedGarmentUrl = async (path: string) => {
  const { data, error } = await supabase.storage.from(GARMENT_BUCKET).createSignedUrl(path, 60 * 60 * 24);
  if (error || !data?.signedUrl) throw new Error(`No hemos podido abrir la foto: ${error?.message || 'URL no disponible'}`);
  return data.signedUrl;
};

const uploadOutfitImage = async (userId: string, uri: string) => {
  const file = new File(uri);
  const content = await file.arrayBuffer();
  if (!content.byteLength) throw new Error('No hemos podido leer la foto del outfit.');
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const { error } = await supabase.storage.from(OUTFIT_BUCKET).upload(path, content, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
  });
  if (error) throw new Error(`No hemos podido subir la foto del outfit: ${error.message}`);
  return path;
};

const signedOutfitUrl = async (path: string) => {
  const { data, error } = await supabase.storage.from(OUTFIT_BUCKET).createSignedUrl(path, 60 * 60 * 24);
  if (error || !data?.signedUrl) throw new Error(`No hemos podido abrir la foto del outfit: ${error?.message || 'URL no disponible'}`);
  return data.signedUrl;
};

const garmentPayload = (item: SavedGarment, imagePath: string) => ({
  custom_name: item.customName?.trim() || null,
  category: item.category || '',
  subcategory: item.subcategory || '',
  primary_color: canonicalColor(item.primaryColor),
  secondary_colors: (item.secondaryColors || []).map(canonicalColor),
  styles: item.styles || [],
  pattern: item.pattern || '',
  brand: item.brand || '',
  material_estimate: item.materialEstimate || '',
  fabric_type: item.fabricType || '',
  texture: item.texture || '',
  material_confidence: item.materialConfidence || 0,
  confidence: item.confidence || 0,
  image_path: imagePath,
  wear_count: item.wearCount || 1,
  scan_fingerprint: item.scanFingerprint
    ? { ...item.scanFingerprint, primaryColor: canonicalColor(item.scanFingerprint.primaryColor) }
    : null,
});

const rowToSavedGarment = (row: DatabaseGarmentRow, imageUri: string): SavedGarment => ({
  id: row.id,
  imageUri,
  storagePath: row.image_path,
  wearCount: row.wear_count,
  customName: row.custom_name || undefined,
  category: row.category,
  subcategory: row.subcategory,
  primaryColor: canonicalColor(row.primary_color),
  secondaryColors: toStringArray(row.secondary_colors).map(canonicalColor),
  styles: toStringArray(row.styles),
  pattern: row.pattern,
  brand: row.brand,
  materialEstimate: row.material_estimate,
  fabricType: row.fabric_type,
  texture: row.texture,
  materialConfidence: row.material_confidence,
  confidence: row.confidence,
  scanFingerprint: row.scan_fingerprint as GarmentFingerprint | undefined,
  itemBox: { xMin: 0, yMin: 0, xMax: 1000, yMax: 1000 },
  displayRotation: 0,
});

const analysisMessages = [
  'Preparando tu armario',
  'Identificando las prendas',
  'Analizando colores y tejidos',
  'Buscando marcas visibles',
  'Organizando cada detalle',
  'Tu outfit está casi listo',
];

function LoadingDecorations({ visible }: { visible: boolean }) {
  const topMotion = useState(() => new Animated.Value(0))[0];
  const bottomMotion = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (!visible) { topMotion.setValue(0); bottomMotion.setValue(0); return undefined; }
    let active = true;
    let topAnimation: Animated.CompositeAnimation | null = null;
    let bottomAnimation: Animated.CompositeAnimation | null = null;
    const moveTop = () => { topAnimation = Animated.timing(topMotion, { toValue: Math.random(), duration: 900 + Math.round(Math.random() * 2200), easing: Easing.inOut(Easing.quad), useNativeDriver: true }); topAnimation.start(({ finished }) => { if (active && finished) moveTop(); }); };
    const moveBottom = () => { bottomAnimation = Animated.timing(bottomMotion, { toValue: Math.random(), duration: 1100 + Math.round(Math.random() * 2600), easing: Easing.inOut(Easing.quad), useNativeDriver: true }); bottomAnimation.start(({ finished }) => { if (active && finished) moveBottom(); }); };
    moveTop();
    const bottomDelay = setTimeout(moveBottom, 540);
    return () => { active = false; clearTimeout(bottomDelay); topAnimation?.stop(); bottomAnimation?.stop(); };
  }, [visible, topMotion, bottomMotion]);
  return <><Animated.View style={[styles.loadingDecorationTop, { transform: [{ translateX: topMotion.interpolate({ inputRange: [0, 1], outputRange: [80, -420] }) }, { translateY: topMotion.interpolate({ inputRange: [0, 1], outputRange: [-45, 640] }) }, { scale: topMotion.interpolate({ inputRange: [0, 1], outputRange: [1.08, 0.88] }) }] }]} /><Animated.View style={[styles.loadingDecorationBottom, { transform: [{ translateX: bottomMotion.interpolate({ inputRange: [0, 1], outputRange: [-70, 420] }) }, { translateY: bottomMotion.interpolate({ inputRange: [0, 1], outputRange: [90, -690] }) }, { scale: bottomMotion.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.12] }) }] }]} /></>;
}

function AnalysisLoading({ visible }: { visible: boolean }) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (!visible) {
      setMessageIndex(0);
      return undefined;
    }
    const timer = setInterval(() => setMessageIndex((current) => (current + 1) % analysisMessages.length), 3000);
    return () => clearInterval(timer);
  }, [visible]);

  return <Modal visible={visible} animationType="fade" statusBarTranslucent>
    <SafeAreaView style={styles.loadingScreen}>
      <LoadingDecorations visible={visible} />
      <View style={styles.loadingContent}>
        <Text style={styles.loadingEyebrow}>ANALIZANDO OUTFIT</Text>
        <View style={styles.loadingIcon}><Feather name="zap" size={30} color={COLORS.white} /></View>
        <Text style={styles.loadingTitle} accessibilityLiveRegion="polite">{analysisMessages[messageIndex]}</Text>
        <Text style={styles.loadingText}>Gemini está separando y clasificando las prendas de tu foto.</Text>
        <ActivityIndicator size="small" color={COLORS.sageDark} style={styles.loadingSpinner} />
      </View>
    </SafeAreaView>
  </Modal>;
}

const preparationMessages = [
  'Preparando tus prendas',
  'Recortando cada prenda',
  'Buscando coincidencias',
  'Comparando con tu armario',
  'Comprobando los detalles',
  'Terminando de organizarlo todo',
];

function PreparationLoading({ visible }: { visible: boolean }) {
  const [messageIndex, setMessageIndex] = useState(0);
  useEffect(() => {
    if (!visible) {
      setMessageIndex(0);
      return undefined;
    }
    const timer = setInterval(() => setMessageIndex((current) => (current + 1) % preparationMessages.length), 3000);
    return () => clearInterval(timer);
  }, [visible]);

  return <Modal visible={visible} animationType="fade" statusBarTranslucent>
    <SafeAreaView style={styles.preparationScreen}>
      <LoadingDecorations visible={visible} />
      <View style={styles.loadingContent}>
        <Text style={styles.loadingEyebrow}>PREPARANDO ARMARIO</Text>
        <View style={styles.preparationIcon}><Feather name="archive" size={29} color={COLORS.white} /></View>
        <Text style={styles.loadingTitle} accessibilityLiveRegion="polite">{preparationMessages[messageIndex]}</Text>
        <Text style={styles.loadingText}>Estamos preparando las imágenes y comprobando que no hayas guardado antes la misma prenda.</Text>
        <ActivityIndicator size="small" color={COLORS.sageDark} style={styles.loadingSpinner} />
      </View>
    </SafeAreaView>
  </Modal>;
}

function AppNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  if (!notice) return null;
  const actions = notice.actions?.length ? notice.actions : [{ label: 'Entendido' }];
  return <Modal visible transparent animationType="fade" onRequestClose={onDismiss}><View style={styles.noticeBackdrop}><TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={onDismiss} /><View style={styles.noticeCard}><View style={styles.noticeIcon}><Feather name={notice.actions?.some((action) => action.destructive) ? 'alert-circle' : 'info'} size={23} color={notice.actions?.some((action) => action.destructive) ? COLORS.clay : COLORS.sageDark} /></View><Text style={styles.noticeTitle}>{notice.title}</Text><Text style={styles.noticeMessage}>{notice.message}</Text><View style={styles.noticeActions}>{actions.map((action, index) => <TouchableOpacity key={`${action.label}-${index}`} style={[styles.noticeAction, action.destructive ? styles.noticeActionDestructive : index === actions.length - 1 && styles.noticeActionPrimary]} onPress={() => { onDismiss(); action.onPress?.(); }}><Text style={[styles.noticeActionText, action.destructive ? styles.noticeActionTextDestructive : index === actions.length - 1 && styles.noticeActionTextPrimary]}>{action.label}</Text></TouchableOpacity>)}</View></View></View></Modal>;
}

function EmptyScreen({ tab }: { tab: Exclude<Tab, 'captura'> }) {
  const content = {
    armario: ['Tu armario', 'Filtra y encuentra cada prenda que hayas guardado.', 'grid'],
    outfits: ['Tus outfits', 'Aquí aparecerán tus outfits analizados y sus valoraciones.', 'layers'],
    compras: ['Compras para ti', 'Sugerencias de comercios seleccionados que combinan con lo que ya tienes.', 'shopping-bag'],
    perfil: ['Tu perfil', 'Preferencias de estilo, tallas, colores y comercios.', 'user'],
    inicio: ['', '', 'home'],
  }[tab] as [string, string, keyof typeof Feather.glyphMap];
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Feather name={content[2]} size={30} color={COLORS.sageDark} /></View>
      <Text style={styles.emptyTitle}>{content[0]}</Text>
      <Text style={styles.emptyText}>{content[1]}</Text>
    </View>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [loading, setLoading] = useState<'email' | 'google' | 'apple' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);

  const redirectTo = makeRedirectUri({ scheme: 'armario-virtual', path: 'auth/callback' });

  const signInWithProvider = async (provider: 'google' | 'apple') => {
    setLoading(provider);
    setMessage(null);
    try {
      console.log('[Supabase] OAuth redirect URL:', redirectTo);
      const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
      if (error) throw error;
      if (!data.url) throw new Error('No hemos recibido una URL de autorización.');
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      const returnedUrl = 'url' in result && result.url ? result.url : null;
      const safeReturnedUrl = returnedUrl?.replace(/([?&#](?:code|access_token|refresh_token|error_description)=)[^&#]*/g, '$1[redacted]') || null;
      console.log('[Supabase] Resultado del navegador OAuth:', { type: result.type, url: safeReturnedUrl });
      if (result.type === 'success' && result.url) {
        const parsed = Linking.parse(result.url);
        const code = typeof parsed.queryParams?.code === 'string' ? parsed.queryParams.code : null;
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
        } else {
          const fragment = result.url.split('#')[1] || '';
          const fragmentParams = new URLSearchParams(fragment);
          const accessToken = fragmentParams.get('access_token');
          const refreshToken = fragmentParams.get('refresh_token');
          if (!accessToken || !refreshToken) throw new Error('Google no ha devuelto una sesión válida a la app.');
          const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (sessionError) throw sessionError;
        }
      } else if (result.type !== 'cancel' && result.type !== 'dismiss') {
        throw new Error('La autorización no se ha completado.');
      }
    } catch (error) {
      console.error(`[Supabase] Error con ${provider}:`, error);
      setMessage(error instanceof Error ? error.message : 'No hemos podido iniciar sesión.');
    } finally {
      setLoading(null);
    }
  };

  const submitEmail = async () => {
    if (!email.trim() || password.length < 6) {
      setMessage('Introduce un correo válido y una contraseña de al menos 6 caracteres.');
      return;
    }
    setLoading('email');
    setMessage(null);
    try {
      const credentials = { email: email.trim().toLocaleLowerCase(), password };
      const result = mode === 'signIn'
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp({ ...credentials, options: { emailRedirectTo: redirectTo } });
      if (result.error) throw result.error;
      if (mode === 'signUp' && !result.data.session) setMessage('Te hemos enviado un correo para confirmar tu cuenta.');
    } catch (error) {
      console.error('[Supabase] Error con correo:', error);
      setMessage(error instanceof Error ? error.message : 'No hemos podido completar el acceso.');
    } finally {
      setLoading(null);
    }
  };

  const resetPassword = async () => {
    const normalizedEmail = email.trim().toLocaleLowerCase();
    if (!normalizedEmail) {
      setMessage('Escribe tu correo para que podamos enviarte el enlace de recuperación.');
      return;
    }
    setLoading('email');
    setMessage(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
      if (error) throw error;
      setMessage('Te hemos enviado un enlace para restablecer tu contraseña.');
    } catch (error) {
      console.error('[Supabase] Error al recuperar la contraseña:', error);
      setMessage(error instanceof Error ? error.message : 'No hemos podido enviar el enlace de recuperación.');
    } finally {
      setLoading(null);
    }
  };

  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="dark-content" backgroundColor={COLORS.paper} translucent={false} />
    <ScrollView contentContainerStyle={styles.loginScroll} keyboardShouldPersistTaps="handled">
      <View style={styles.loginHero}>
        <View style={styles.loginWordmark}><View style={styles.loginWordmarkDot} /><Text style={styles.loginWordmarkText}>ARMARIO</Text><Text style={styles.loginWordmarkSub}>PERSONAL</Text></View>
        <View style={styles.loginWelcome}>
          <View style={styles.loginWelcomeCopy}>
            <Text style={styles.loginWelcomeKicker}>UN ESPACIO PARA TU ESTILO</Text>
            <Text style={styles.loginWelcomeTitle}>Tu armario,{`\n`}bien pensado.</Text>
            <Text style={styles.loginWelcomeText}>Organiza lo que tienes y encuentra formas nuevas de llevarlo.</Text>
          </View>
          <View style={styles.loginWelcomeArtwork}>
            <View style={styles.loginWelcomeArch} />
            <View style={styles.loginWelcomeTile} />
            <View style={styles.loginWelcomeIcon}><Feather name="layers" size={22} color={COLORS.ink} /></View>
          </View>
        </View>
      </View>
      <View style={styles.loginCard}>
        <Text style={styles.loginCardEyebrow}>{mode === 'signIn' ? 'TU ESPACIO PERSONAL' : 'EMPIEZA TU COLECCIÓN'}</Text>
        <Text style={styles.loginCardTitle}>{mode === 'signIn' ? 'Qué alegría verte de nuevo.' : 'Crea tu armario personal.'}</Text>
        <Text style={styles.loginCardDescription}>{mode === 'signIn' ? 'Entra para continuar organizando tus looks.' : 'Guarda tus prendas y descubre nuevas combinaciones.'}</Text>
        <View style={styles.loginFieldGroup}>
          <Text style={styles.loginFieldLabel}>Correo electrónico</Text>
          <View style={[styles.loginInputWrap, focusedField === 'email' && styles.loginInputWrapFocused]}>
            <Feather name="mail" size={17} color={focusedField === 'email' ? COLORS.sageDark : COLORS.muted} />
            <TextInput value={email} onChangeText={setEmail} onFocus={() => setFocusedField('email')} onBlur={() => setFocusedField(null)} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" placeholder="tu@email.com" placeholderTextColor="#9B958E" style={styles.loginInput} accessibilityLabel="Correo electrónico" />
          </View>
        </View>
        <View style={styles.loginFieldGroup}>
          <View style={styles.loginPasswordLabelRow}>
            <Text style={styles.loginFieldLabel}>Contraseña</Text>
            {mode === 'signIn' && <TouchableOpacity onPress={() => void resetPassword()} disabled={loading !== null} hitSlop={8} accessibilityRole="button" accessibilityLabel="Recuperar contraseña"><Text style={styles.loginForgot}>¿La has olvidado?</Text></TouchableOpacity>}
          </View>
          <View style={[styles.loginInputWrap, focusedField === 'password' && styles.loginInputWrapFocused]}>
            <Feather name="lock" size={17} color={focusedField === 'password' ? COLORS.sageDark : COLORS.muted} />
            <TextInput value={password} onChangeText={setPassword} onFocus={() => setFocusedField('password')} onBlur={() => setFocusedField(null)} secureTextEntry={!passwordVisible} autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} textContentType={mode === 'signIn' ? 'password' : 'newPassword'} placeholder="Mínimo 6 caracteres" placeholderTextColor="#9B958E" style={styles.loginInput} accessibilityLabel="Contraseña" />
            <TouchableOpacity onPress={() => setPasswordVisible((current) => !current)} hitSlop={8} accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}><Feather name={passwordVisible ? 'eye-off' : 'eye'} size={18} color={COLORS.muted} /></TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity disabled={loading !== null} onPress={() => void submitEmail()} style={[styles.loginPrimary, loading === 'email' && styles.buttonDisabled]}><Text style={styles.loginPrimaryText}>{loading === 'email' ? 'Un momento…' : mode === 'signIn' ? 'Iniciar sesión' : 'Crear cuenta'}</Text></TouchableOpacity>
        <TouchableOpacity disabled={loading !== null} onPress={() => { setMode((current) => current === 'signIn' ? 'signUp' : 'signIn'); setMessage(null); }} style={styles.loginSwitch} accessibilityRole="button"><Text style={styles.loginSwitchPrompt}>{mode === 'signIn' ? '¿Es tu primera vez?' : '¿Ya tienes una cuenta?'}</Text><Text style={styles.loginSwitchText}>{mode === 'signIn' ? ' Crear cuenta' : ' Iniciar sesión'}</Text></TouchableOpacity>
        <View style={styles.loginDivider}><View style={styles.loginDividerLine} /><Text style={styles.loginDividerText}>O continúa con</Text><View style={styles.loginDividerLine} /></View>
        <TouchableOpacity disabled={loading !== null} onPress={() => void signInWithProvider('google')} style={[styles.loginSocial, loading === 'google' && styles.buttonDisabled]}><MaterialCommunityIcons name="google" size={19} color="#4285F4" style={styles.loginGoogleIcon} /><Text style={styles.loginSocialText}>{loading === 'google' ? 'Abriendo Google…' : 'Continuar con Google'}</Text></TouchableOpacity>
        <TouchableOpacity disabled={loading !== null} onPress={() => void signInWithProvider('apple')} style={[styles.loginSocial, styles.loginApple, loading === 'apple' && styles.buttonDisabled]}><MaterialCommunityIcons name="apple" size={21} color={COLORS.white} style={styles.loginAppleIcon} /><Text style={styles.loginAppleText}>{loading === 'apple' ? 'Abriendo Apple…' : 'Continuar con Apple'}</Text></TouchableOpacity>
        {message && <Text style={styles.loginMessage}>{message}</Text>}
      </View>
      <Text style={styles.loginLegal}>Al continuar, aceptas que guardemos tu perfil y tu armario de forma segura.</Text>
    </ScrollView>
  </SafeAreaView>;
}

const STYLE_OPTIONS = ['Casual', 'Minimalista', 'Clásico', 'Urbano', 'Deportivo', 'Elegante'];
const STYLE_DESCRIPTIONS: Record<string, string> = { Casual: 'Fácil · relajado', Minimalista: 'Limpio · esencial', Clásico: 'Atemporal · pulido', Urbano: 'Actual · expresivo', Deportivo: 'Activo · funcional', Elegante: 'Refinado · especial' };
const STYLE_ACCENTS: Record<string, string> = { Casual: '#D98567', Minimalista: '#BFCBB4', Clásico: '#C9B69D', Urbano: '#9699A8', Deportivo: '#9DB6A5', Elegante: '#B7A0A1' };
const COLOR_OPTIONS = ['Negro', 'Blanco', 'Azul', 'Beige', 'Marrón', 'Verde', 'Rojo', 'Rosa'];
const COLOR_SWATCHES: Record<string, string> = { Negro: '#252422', Blanco: '#F4F1EA', Azul: '#758DA5', Beige: '#DCCCB6', Marrón: '#8A6650', Verde: '#809078', Rojo: '#B9655A', Rosa: '#D4A1A2' };
const BRAND_OPTIONS = [
  { name: 'Zara', mark: 'ZARA' }, { name: 'UNIQLO', mark: 'UNIQLO' }, { name: 'COS', mark: 'COS' },
  { name: 'Mango', mark: 'MANGO' }, { name: 'ARKET', mark: 'ARKET' }, { name: 'Massimo Dutti', mark: 'MASSIMO DUTTI' },
  { name: 'H&M', mark: 'H&M' }, { name: 'Pull&Bear', mark: 'PULL&BEAR' }, { name: 'Bershka', mark: 'BERSHKA' }, { name: 'Stradivarius', mark: 'STRADIVARIUS' },
  { name: 'Oysho', mark: 'OYSHO' }, { name: 'Lefties', mark: 'LEFTIES' }, { name: 'Primark', mark: 'PRIMARK' }, { name: 'Cortefiel', mark: 'CORTEFIEL' },
  { name: 'Sandro', mark: 'SANDRO' }, { name: 'Maje', mark: 'MAJE' }, { name: 'Sézane', mark: 'SÉZANE' }, { name: 'Rouje', mark: 'ROUJE' },
  { name: 'Aritzia', mark: 'ARITZIA' }, { name: 'Reformation', mark: 'REFORMATION' }, { name: 'Everlane', mark: 'EVERLANE' }, { name: 'Abercrombie', mark: 'ABERCROMBIE' },
  { name: 'Levi’s', mark: 'LEVI’S' }, { name: 'Carhartt WIP', mark: 'CARHARTT WIP' }, { name: 'Dickies', mark: 'DICKIES' }, { name: 'Patagonia', mark: 'PATAGONIA' },
  { name: 'The North Face', mark: 'THE NORTH FACE' }, { name: 'Nike', mark: 'NIKE' }, { name: 'Adidas', mark: 'ADIDAS' }, { name: 'New Balance', mark: 'NEW BALANCE' },
  { name: 'Puma', mark: 'PUMA' }, { name: 'Asics', mark: 'ASICS' }, { name: 'Veja', mark: 'VEJA' }, { name: 'On', mark: 'ON' },
  { name: 'Dr. Martens', mark: 'DR. MARTENS' }, { name: 'Birkenstock', mark: 'BIRKENSTOCK' }, { name: 'Vans', mark: 'VANS' }, { name: 'Converse', mark: 'CONVERSE' },
  { name: 'Lacoste', mark: 'LACOSTE' }, { name: 'Ralph Lauren', mark: 'RALPH LAUREN' }, { name: 'Tommy Hilfiger', mark: 'TOMMY HILFIGER' }, { name: 'Calvin Klein', mark: 'CALVIN KLEIN' },
  { name: 'Gant', mark: 'GANT' }, { name: 'Polo Ralph Lauren', mark: 'POLO' }, { name: 'A.P.C.', mark: 'A.P.C.' }, { name: 'Acne Studios', mark: 'ACNE STUDIOS' },
  { name: 'Totême', mark: 'TOTÊME' }, { name: 'Ganni', mark: 'GANNI' }, { name: 'Lululemon', mark: 'LULULEMON' }, { name: 'Uniqlo U', mark: 'UNIQLO U' },
  { name: '& Other Stories', mark: '& OTHER STORIES' }, { name: 'Weekday', mark: 'WEEKDAY' }, { name: 'Monki', mark: 'MONKI' }, { name: 'NA-KD', mark: 'NA-KD' },
  { name: 'Adolfo Domínguez', mark: 'ADOLFO DOMÍNGUEZ' }, { name: 'Bimba y Lola', mark: 'BIMBA Y LOLA' }, { name: 'Desigual', mark: 'DESIGUAL' }, { name: 'Pedro del Hierro', mark: 'PEDRO DEL HIERRO' },
  { name: 'El Ganso', mark: 'EL GANSO' }, { name: 'Scalpers', mark: 'SCALPERS' }, { name: 'Loewe', mark: 'LOEWE' }, { name: 'Miu Miu', mark: 'MIU MIU' },
  { name: 'Gucci', mark: 'GUCCI' }, { name: 'Prada', mark: 'PRADA' }, { name: 'Valentino', mark: 'VALENTINO' }, { name: 'Saint Laurent', mark: 'SAINT LAURENT' },
  { name: 'Burberry', mark: 'BURBERRY' }, { name: 'Balenciaga', mark: 'BALENCIAGA' }, { name: 'Bottega Veneta', mark: 'BOTTEGA VENETA' }, { name: 'Jacquemus', mark: 'JACQUEMUS' },
  { name: 'Maison Margiela', mark: 'MAISON MARGIELA' }, { name: 'Isabel Marant', mark: 'ISABEL MARANT' }, { name: 'Marni', mark: 'MARNI' }, { name: 'Etro', mark: 'ETRO' },
  { name: 'Hugo Boss', mark: 'HUGO BOSS' }, { name: 'Armani Exchange', mark: 'A|X' }, { name: 'Diesel', mark: 'DIESEL' }, { name: 'Guess', mark: 'GUESS' },
  { name: 'Superdry', mark: 'SUPERDRY' }, { name: 'AllSaints', mark: 'ALLSAINTS' }, { name: 'Lacoste Sport', mark: 'LACOSTE SPORT' }, { name: 'Fred Perry', mark: 'FRED PERRY' },
  { name: 'Champion', mark: 'CHAMPION' }, { name: 'Reebok', mark: 'REEBOK' }, { name: 'Under Armour', mark: 'UNDER ARMOUR' }, { name: 'Salomon', mark: 'SALOMON' },
  { name: 'Hoka', mark: 'HOKA' }, { name: 'New Era', mark: 'NEW ERA' }, { name: 'Stüssy', mark: 'STÜSSY' }, { name: 'Supreme', mark: 'SUPREME' },
  { name: 'Essentials', mark: 'ESSENTIALS' }, { name: 'Fear of God', mark: 'FEAR OF GOD' }, { name: 'Stone Island', mark: 'STONE ISLAND' }, { name: 'Lemaire', mark: 'LEMAIRE' },
  { name: 'Massimo Alba', mark: 'MASSIMO ALBA' }, { name: 'Sézane Paris', mark: 'SÉZANE PARIS' }, { name: 'Camaïeu', mark: 'CAMAÏEU' }, { name: 'Kiabi', mark: 'KIABI' },
  { name: 'Springfield', mark: 'SPRINGFIELD' }, { name: 'Women’secret', mark: 'WOMEN’SECRET' }, { name: 'Intimissimi', mark: 'INTIMISSIMI' }, { name: 'Calzedonia', mark: 'CALZEDONIA' },
  { name: 'Kiko Milano', mark: 'KIKO MILANO' }, { name: 'Urban Outfitters', mark: 'URBAN OUTFITTERS' }, { name: 'Anthropologie', mark: 'ANTHROPOLOGIE' }, { name: 'Free People', mark: 'FREE PEOPLE' },
  { name: 'Net-a-Porter', mark: 'NET-A-PORTER' }, { name: 'Farfetch', mark: 'FARFETCH' }, { name: 'Mytheresa', mark: 'MYTHERESA' }, { name: 'Vinted', mark: 'VINTED' },
];
const GENDER_OPTIONS = ['Mujer', 'Hombre', 'No binario', 'Prefiero no indicarlo'];

function OnboardingScreen({ onComplete, initialName, initialGender, initialStyles, initialColors, initialShops, initialShowOutfitScore = true, initialShowImprovementPoints = true }: { onComplete: () => void; initialName?: string; initialGender?: string; initialStyles?: string[]; initialColors?: string[]; initialShops?: string[]; initialShowOutfitScore?: boolean; initialShowImprovementPoints?: boolean }) {
  const [name, setName] = useState(initialName || '');
  const [gender, setGender] = useState(initialGender || '');
  const [stylePreferences, setStylePreferences] = useState<string[]>(initialStyles || []);
  const [colors, setColors] = useState<string[]>(initialColors || []);
  const [shops, setShops] = useState((initialShops || []).filter((shop) => BRAND_OPTIONS.some((brand) => brand.name === shop)).join(', '));
  const [otherBrand, setOtherBrand] = useState((initialShops || []).filter((shop) => !BRAND_OPTIONS.some((brand) => brand.name === shop)).join(', '));
  const [brandQuery, setBrandQuery] = useState('');
  const [showOutfitScore, setShowOutfitScore] = useState(initialShowOutfitScore);
  const [showImprovementPoints, setShowImprovementPoints] = useState(initialShowImprovementPoints);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const visibleBrands = BRAND_OPTIONS.filter(({ name }) => name.toLocaleLowerCase().includes(brandQuery.trim().toLocaleLowerCase()));
  const toggle = (value: string, setter: Dispatch<SetStateAction<string[]>>) => setter((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);

  const saveProfile = async () => {
    if (!name.trim() || !gender) {
      setMessage('Indica cómo quieres que te llamemos y selecciona una opción de género.');
      return;
    }
    setSaving(true);
    setMessage(null);
    const favoriteShops = [...shops.split(',').map((shop) => shop.trim()).filter(Boolean), otherBrand.trim()].filter(Boolean);
    const { error } = await supabase.auth.updateUser({ data: {
      display_name: name.trim(),
      gender_identity: gender,
      style_preferences: stylePreferences,
      color_preferences: colors,
      favorite_shops: favoriteShops,
      show_outfit_score: showOutfitScore,
      show_improvement_points: showImprovementPoints,
      onboarding_completed: true,
      onboarding_completed_at: new Date().toISOString(),
    } });
    setSaving(false);
    if (error) {
      console.error('[Supabase] Error guardando el perfil inicial:', error);
      setMessage(error.message);
      return;
    }
    onComplete();
  };

  const continueOnboarding = () => {
    if (step < 3) {
      if (step === 0 && (!name.trim() || !gender)) {
        setMessage('Completa tu nombre y selecciona una opción de género.');
        return;
      }
      setMessage(null);
      setStep((current) => current + 1);
      return;
    }
    void saveProfile();
  };

  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="dark-content" backgroundColor={COLORS.paper} translucent={false} />
    <ScrollView contentContainerStyle={styles.onboardingScroll} keyboardShouldPersistTaps="handled">
      <View style={styles.onboardingTop}><TouchableOpacity disabled={step === 0} onPress={() => setStep((current) => Math.max(0, current - 1))} style={styles.onboardingBack}>{step > 0 && <><Feather name="arrow-left" size={17} color={COLORS.ink} /><Text style={styles.onboardingBackText}>Atrás</Text></>}</TouchableOpacity><Text style={styles.onboardingCounter}>{step + 1} / 4</Text></View>
      <View style={styles.onboardingDots}>{[0, 1, 2, 3].map((dot) => <View key={dot} style={[styles.onboardingDot, dot === step && styles.onboardingDotActive, dot < step && styles.onboardingDotComplete]} />)}</View>
      <View style={styles.onboardingHero}><View style={styles.onboardingStepIcon}><Feather name={step === 0 ? 'user' : step === 1 ? 'star' : step === 2 ? 'sliders' : 'tag'} size={22} color={COLORS.white} /></View><Text style={styles.loginEyebrow}>{step === 0 ? 'EMPECEMOS' : step === 1 ? 'TU ESTILO' : step === 2 ? 'TU PALETA' : 'TUS MARCAS'}</Text><Text style={styles.onboardingTitle}>{step === 0 ? 'Tu armario empieza aquí.' : step === 1 ? '¿Cómo te gusta vestir?' : step === 2 ? 'Dale color a tu armario.' : '¿Qué marcas te inspiran?'}</Text><Text style={styles.onboardingSubtitle}>{step === 0 ? 'Un par de detalles y empezamos a construir tu espacio personal.' : step === 1 ? 'Elige las opciones que más se parezcan a ti.' : step === 2 ? 'Así podremos crear recomendaciones más personales.' : 'Elige tus referencias para descubrir prendas que encajen contigo.'}</Text></View>
      <View style={styles.onboardingCard}>
        {step === 0 && <><View style={styles.onboardingCardHeader}><View><Text style={styles.onboardingCardEyebrow}>PERFIL PERSONAL</Text><Text style={styles.onboardingCardIntro}>Cuéntanos un poco sobre ti</Text></View><Feather name="edit-3" size={18} color={COLORS.sageDark} /></View><Text style={styles.onboardingFieldLabel}>NOMBRE</Text><TextInput value={name} onChangeText={setName} autoCapitalize="words" placeholder="Tu nombre" placeholderTextColor="#9B958E" style={styles.loginStandaloneInput} /><Text style={styles.onboardingSectionTitle}>Género</Text><Text style={styles.onboardingHint}>Lo usaremos para adaptar la experiencia a ti.</Text><View style={styles.genderGrid}>{GENDER_OPTIONS.map((option) => { const selected = gender === option; return <TouchableOpacity key={option} onPress={() => setGender(option)} style={[styles.genderCard, selected && styles.genderCardActive]}><Text style={[styles.genderCardText, selected && styles.genderCardTextActive]}>{option}</Text>{selected && <Feather name="check" size={14} color={COLORS.white} />}</TouchableOpacity>; })}</View></>}
        {step === 1 && <><Text style={styles.onboardingSectionTitle}>Tu estilo</Text><Text style={styles.onboardingHint}>Puedes elegir varias opciones.</Text><View style={styles.styleGrid}>{STYLE_OPTIONS.map((option) => { const selected = stylePreferences.includes(option); return <TouchableOpacity key={option} onPress={() => toggle(option, setStylePreferences)} style={[styles.styleCard, selected && styles.styleCardActive]}><View style={[styles.styleCardAccent, { backgroundColor: STYLE_ACCENTS[option] }]} /><View style={styles.styleCardCopy}><Text style={[styles.styleCardTitle, selected && styles.styleCardTitleActive]}>{option}</Text><Text style={[styles.styleCardDescription, selected && styles.styleCardDescriptionActive]}>{STYLE_DESCRIPTIONS[option]}</Text></View><View style={[styles.styleCardCheck, selected && styles.styleCardCheckActive]}>{selected && <Feather name="check" size={12} color={COLORS.white} />}</View></TouchableOpacity>; })}</View></>}
        {step === 2 && <><Text style={styles.onboardingSectionTitle}>Colores que más usas</Text><Text style={styles.onboardingHint}>Construiremos tu paleta a partir de estos tonos.</Text><View style={styles.colorGrid}>{COLOR_OPTIONS.map((option) => { const selected = colors.includes(option); return <TouchableOpacity key={option} onPress={() => toggle(option, setColors)} style={[styles.colorCard, selected && styles.colorCardActive]}><View style={[styles.colorSwatch, { backgroundColor: COLOR_SWATCHES[option] }, option === 'Blanco' && styles.colorSwatchLight]}>{selected && <Feather name="check" size={13} color={option === 'Blanco' ? COLORS.ink : COLORS.white} />}</View><Text style={[styles.colorCardText, selected && styles.colorCardTextActive]}>{option}</Text></TouchableOpacity>; })}</View></>}
        {step === 3 && <><Text style={styles.onboardingSectionTitle}>Tu análisis</Text><Text style={styles.onboardingHint}>Elige cómo quieres recibir el feedback de cada outfit.</Text><View style={styles.feedbackOptions}><TouchableOpacity onPress={() => setShowOutfitScore((current) => !current)} style={[styles.feedbackOption, showOutfitScore && styles.feedbackOptionActive]}><View style={styles.feedbackOptionIcon}><Feather name="star" size={17} color={showOutfitScore ? COLORS.sageDark : COLORS.muted} /></View><View style={styles.feedbackOptionCopy}><Text style={styles.feedbackOptionTitle}>Ver puntuación</Text><Text style={styles.feedbackOptionText}>Una nota global de tu outfit.</Text></View><Feather name={showOutfitScore ? 'check-circle' : 'circle'} size={20} color={showOutfitScore ? COLORS.sageDark : COLORS.muted} /></TouchableOpacity><TouchableOpacity onPress={() => setShowImprovementPoints((current) => !current)} style={[styles.feedbackOption, showImprovementPoints && styles.feedbackOptionActive]}><View style={styles.feedbackOptionIcon}><Feather name="trending-up" size={17} color={showImprovementPoints ? COLORS.sageDark : COLORS.muted} /></View><View style={styles.feedbackOptionCopy}><Text style={styles.feedbackOptionTitle}>Ver puntos de mejora</Text><Text style={styles.feedbackOptionText}>Ideas para pulir el conjunto.</Text></View><Feather name={showImprovementPoints ? 'check-circle' : 'circle'} size={20} color={showImprovementPoints ? COLORS.sageDark : COLORS.muted} /></TouchableOpacity></View><Text style={styles.onboardingSectionTitle}>Marcas que te inspiran</Text><Text style={styles.onboardingHint}>Busca entre nuestras marcas y elige todas las que quieras.</Text><View style={styles.brandSearchWrap}><Feather name="search" size={17} color={COLORS.muted} /><TextInput value={brandQuery} onChangeText={setBrandQuery} placeholder="Buscar marca" placeholderTextColor="#9B958E" style={styles.brandSearch} autoCapitalize="none" autoCorrect={false} /></View>{visibleBrands.length > 0 ? <View style={styles.brandGrid}>{visibleBrands.map(({ name, mark }) => { const selected = shops.split(',').map((shop) => shop.trim()).includes(name); return <TouchableOpacity key={name} onPress={() => setShops((current) => { const values = current.split(',').map((shop) => shop.trim()).filter(Boolean); return (selected ? values.filter((shop) => shop !== name) : [...values, name]).join(', '); })} style={[styles.brandCard, selected && styles.brandCardActive]}><View style={styles.brandLogo}><Text numberOfLines={1} adjustsFontSizeToFit style={[styles.brandLogoText, selected && styles.brandLogoTextActive]}>{mark}</Text></View><Text style={[styles.brandFallback, selected && styles.brandFallbackActive]}>{name}</Text>{selected && <View style={styles.brandCheck}><Feather name="check" size={11} color={COLORS.white} /></View>}</TouchableOpacity>; })}</View> : <Text style={styles.brandEmpty}>No hemos encontrado esa marca. Puedes añadirla abajo.</Text>}<View style={styles.onboardingSectionRow}><Text style={styles.onboardingSectionTitle}>Otra marca</Text><Text style={styles.onboardingOptional}>OPCIONAL</Text></View><TextInput value={otherBrand} onChangeText={setOtherBrand} placeholder="Escribe una marca…" placeholderTextColor="#9B958E" style={styles.loginStandaloneInput} /></>}
        {message && <Text style={styles.loginMessage}>{message}</Text>}
      </View>
    </ScrollView>
        <TouchableOpacity disabled={saving} onPress={continueOnboarding} style={[styles.onboardingFloatingButton, saving && styles.buttonDisabled]} accessibilityRole="button" accessibilityLabel={step < 3 ? 'Continuar' : 'Entrar en mi armario'}><Feather name={step < 3 ? 'arrow-right' : 'check'} size={24} color={COLORS.white} /></TouchableOpacity>
  </SafeAreaView>;
}

function Profile({ onBack, email, displayName, onSignOut, onEditSetup }: { onBack: () => void; email?: string; displayName?: string; onSignOut: () => void; onEditSetup: () => void }) {
  return <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
    <View style={{ height: 18 }} />
    <TouchableOpacity style={styles.backButton} onPress={onBack}><Feather name="arrow-left" size={19} color={COLORS.ink} /><Text style={styles.backButtonText}>Volver</Text></TouchableOpacity>
    <View style={{ marginTop: 12, marginBottom: 30 }}><Text style={styles.eyebrow}>MI PERFIL</Text><Text style={styles.title}>{displayName || email?.split('@')[0] || 'Mi cuenta'}</Text><Text style={styles.addIntro}>{email || 'Tus preferencias y datos de estilo.'}</Text></View>
    <TouchableOpacity onPress={onEditSetup} style={styles.homeWardrobeEmpty} accessibilityRole="button" accessibilityLabel="Abrir configuración inicial"><View style={styles.homeWardrobeEmptyIcon}><Feather name="sliders" size={21} color={COLORS.sageDark} /></View><View style={styles.homeWardrobeEmptyCopy}><Text style={styles.homeWardrobeEmptyTitle}>Configuración inicial</Text><Text style={styles.homeWardrobeEmptyText}>Actualiza tu nombre, género, estilo, colores y marcas favoritas.</Text></View><Feather name="chevron-right" size={18} color={COLORS.muted} /></TouchableOpacity>
    <TouchableOpacity onPress={onSignOut} style={styles.signOutButton}><Feather name="log-out" size={17} color="#A54E43" /><Text style={styles.signOutButtonText}>Cerrar sesión</Text></TouchableOpacity>
  </ScrollView>;
}

function AddOutfit({ onSave, wardrobeItems, startWithCamera = false, showOutfitScore = true, showImprovementPoints = true }: { onSave: (items: SavedGarment[], wornItemIds: string[], updatedItems: SavedGarment[], outfit: OutfitDraft, appearanceItems: SavedGarment[], matchedGarmentIds: Record<string, string>) => Promise<void>; wardrobeItems: SavedGarment[]; startWithCamera?: boolean; showOutfitScore?: boolean; showImprovementPoints?: boolean }) {
  const { showNotice } = useNotice();
  const [stage, setStage] = useState<AddStage>('upload');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageType, setImageType] = useState('image/jpeg');
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [photoDate, setPhotoDate] = useState<string | null>(null);
  const [askForPhotoDate, setAskForPhotoDate] = useState(false);
  const [manualPhotoDate, setManualPhotoDate] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [people, setPeople] = useState<PersonAnalysis[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [faceThumbnails, setFaceThumbnails] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [excludedGarments, setExcludedGarments] = useState<number[]>([]);
  const [duplicateReview, setDuplicateReview] = useState<DuplicateReview | null>(null);
  const [duplicateIndex, setDuplicateIndex] = useState(0);
  const [comparisonFullScreenImage, setComparisonFullScreenImage] = useState<string | null>(null);
  const [outfitEvaluation, setOutfitEvaluation] = useState<OutfitEvaluation | null>(null);
  const [youngChildDetected, setYoungChildDetected] = useState(false);
  const [noOutfitFound, setNoOutfitFound] = useState(false);
  const [photoSource, setPhotoSource] = useState<'gallery' | 'camera' | null>(null);
  const [evaluationExpanded, setEvaluationExpanded] = useState(true);
  const [garmentsExpanded, setGarmentsExpanded] = useState(true);
  const cameraLaunchPending = useRef(false);

  const chooseFromGallery = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showNotice({ title: 'Acceso a tus fotos', message: 'Necesitamos permiso para que puedas elegir una foto de tu galería.' });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.9,
      exif: true,
    });

    if (!result.canceled && result.assets[0]) {
      setPhotoSource('gallery');
      setImageUri(result.assets[0].uri);
      setImageType(result.assets[0].mimeType || 'image/jpeg');
      setImageSize({ width: result.assets[0].width, height: result.assets[0].height });
      const asset = result.assets[0] as ImagePicker.ImagePickerAsset & { exif?: Record<string, unknown> };
      const metadataDate = (asset as any).creationTime || asset.exif?.DateTimeOriginal || asset.exif?.DateTimeDigitized || asset.exif?.DateTime || asset.exif?.GPSDateStamp;
      const detectedPhotoDate = metadataDate ? parsePhotoDate(metadataDate as string | number) : null;
      setPhotoDate(detectedPhotoDate);
      setAskForPhotoDate(!detectedPhotoDate);
      setManualPhotoDate('');
      console.log('[Foto] Fecha EXIF detectada:', metadataDate || 'no disponible');
      setGarments([]);
      setPeople([]);
      setSelectedPersonId(null);
      setFaceThumbnails({});
      setExcludedGarments([]);
      setDuplicateReview(null);
      setDuplicateIndex(0);
      setOutfitEvaluation(null);
      setYoungChildDetected(false);
      setNoOutfitFound(false);
      setStage('upload');
    }
  };

  const takePhoto = async () => {
    if (cameraLaunchPending.current) return;
    cameraLaunchPending.current = true;
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showNotice({
          title: 'Acceso a la cámara',
          message: permission.canAskAgain
            ? 'Necesitamos permiso para que puedas hacer una foto de tu outfit.'
            : 'El permiso de cámara está bloqueado. Actívalo desde los ajustes de Armario.',
          actions: permission.canAskAgain ? undefined : [
            { label: 'Cancelar' },
            { label: 'Abrir ajustes', onPress: () => void NativeLinking.openSettings() },
          ],
        });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.9, exif: true, cameraType: ImagePicker.CameraType.front });
      if (!result.canceled && result.assets[0]) {
        setPhotoSource('camera');
        const asset = result.assets[0] as ImagePicker.ImagePickerAsset & { exif?: Record<string, unknown> };
        setImageUri(asset.uri);
        setImageType(asset.mimeType || 'image/jpeg');
        setImageSize({ width: asset.width, height: asset.height });
        const metadataDate = (asset as any).creationTime || asset.exif?.DateTimeOriginal || asset.exif?.DateTimeDigitized || asset.exif?.DateTime;
        setPhotoDate(metadataDate ? parsePhotoDate(metadataDate as string | number) : new Date().toISOString());
        setAskForPhotoDate(false);
        setManualPhotoDate('');
        setGarments([]); setPeople([]); setSelectedPersonId(null); setFaceThumbnails({}); setExcludedGarments([]); setDuplicateReview(null); setDuplicateIndex(0); setOutfitEvaluation(null); setYoungChildDetected(false); setStage('upload');
        setNoOutfitFound(false);
      }
    } catch (error) {
      console.error('[Cámara] No se pudo abrir:', error);
      showNotice({ title: 'No hemos podido abrir la cámara', message: 'Comprueba que Armario tiene permiso de cámara e inténtalo de nuevo.' });
    } finally {
      cameraLaunchPending.current = false;
    }
  };

  useEffect(() => { if (startWithCamera && !imageUri) void takePhoto(); }, [startWithCamera]);

  const createFaceThumbnails = async (detectedPeople: PersonAnalysis[]) => {
    if (!imageUri || !imageSize) return;
    const entries = await Promise.all(detectedPeople.map(async (person) => {
      if (!person.faceVisible) return null;
      const box = person.faceBox;
      const boxWidth = Math.max(0, box.xMax - box.xMin);
      const boxHeight = Math.max(0, box.yMax - box.yMin);
      if (boxWidth < 5 || boxHeight < 5) return null;

      const paddingX = boxWidth * 0.28;
      const paddingY = boxHeight * 0.28;
      const xMin = Math.max(0, box.xMin - paddingX);
      const yMin = Math.max(0, box.yMin - paddingY);
      const xMax = Math.min(1000, box.xMax + paddingX);
      const yMax = Math.min(1000, box.yMax + paddingY);
      try {
        const cropped = await ImageManipulator.manipulateAsync(imageUri, [{ crop: {
          originX: Math.round((xMin / 1000) * imageSize.width),
          originY: Math.round((yMin / 1000) * imageSize.height),
          width: Math.max(1, Math.round(((xMax - xMin) / 1000) * imageSize.width)),
          height: Math.max(1, Math.round(((yMax - yMin) / 1000) * imageSize.height)),
        } }], { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
        return [person.id, cropped.uri] as const;
      } catch {
        return null;
      }
    }));
    setFaceThumbnails(Object.fromEntries(entries.filter((entry): entry is readonly [number, string] => entry !== null)));
  };

  const analyzeOutfit = async () => {
    if (!imageUri) return;
    const startedAt = Date.now();
    let status: 'completed' | 'failed' = 'failed';
    let httpStatus: number | null = null;
    let analysisMeta: AnalysisMeta = {};
    let peopleCount: number | null = null;
    let garmentCount: number | null = null;
    let requestStartedAt: number | null = null;
    let requestDurationMs: number | null = null;
    let preparationDurationMs: number | null = null;
    let imageSizeBytes: number | null = null;
    let sentImageSize = imageSize;
    setAnalyzing(true);
    try {
      const preparationStartedAt = Date.now();
      let aiImage = { uri: imageUri, width: imageSize?.width || 0, height: imageSize?.height || 0 };
      try {
        aiImage = await prepareImageForAi(imageUri, imageSize);
      } catch (error) {
        console.warn('[Imagen IA] No se pudo optimizar; se enviará la foto original:', error);
      }
      preparationDurationMs = Date.now() - preparationStartedAt;
      sentImageSize = aiImage.width && aiImage.height ? { width: aiImage.width, height: aiImage.height } : imageSize;
      try {
        imageSizeBytes = new File(aiImage.uri).size || null;
      } catch {
        imageSizeBytes = null;
      }
      const form = new FormData();
      form.append('photo', { uri: aiImage.uri, name: 'outfit.jpg', type: aiImage.uri === imageUri ? imageType : 'image/jpeg' } as unknown as Blob);
      const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
      requestStartedAt = Date.now();
      const response = await fetch(`${apiUrl}/analyze-outfit`, { method: 'POST', body: form });
      httpStatus = response.status;
      const payload = await response.json();
      requestDurationMs = Date.now() - requestStartedAt;
      analysisMeta = payload._analysisMeta || {};
      if (!response.ok) throw new Error(payload.error || 'Error de análisis');
      const detectedPeople: PersonAnalysis[] = (payload.people || []).map((person: PersonAnalysis) => ({
        ...person,
        items: (person.items || []).map(canonicalizeGarmentColors),
      }));
      status = 'completed';
      peopleCount = detectedPeople.length;
      garmentCount = detectedPeople.reduce((total, person) => total + (person.items?.length || 0), 0);
      setYoungChildDetected(payload.youngChildDetected === true);
      setPeople(detectedPeople);
      if (detectedPeople.length > 1) void createFaceThumbnails(detectedPeople);
      if (detectedPeople.length === 1) {
        setSelectedPersonId(detectedPeople[0].id);
        setGarments(detectedPeople[0].items || []);
        setOutfitEvaluation(detectedPeople[0].outfitEvaluation || null);
        setExcludedGarments([]);
        setStage('review');
      } else {
        setSelectedPersonId(null);
        setGarments([]);
        setOutfitEvaluation(null);
        if (detectedPeople.length > 1) setStage('person');
        if (detectedPeople.length === 0) {
          setNoOutfitFound(true);
          setImageUri(null);
          setStage('upload');
        }
      }
    } catch (error) {
      showNotice({ title: 'No hemos podido analizar la foto', message: error instanceof Error ? error.message : 'Comprueba que el servidor esté iniciado.' });
    } finally {
      setAnalyzing(false);
      if (requestStartedAt && requestDurationMs === null) requestDurationMs = Date.now() - requestStartedAt;
      const serverDurationMs = analysisMeta.serverDurationMs ?? null;
      recordAnalysisRun({
        analysis_type: 'outfit',
        status,
        client_duration_ms: Date.now() - startedAt,
        preparation_duration_ms: preparationDurationMs,
        request_duration_ms: requestDurationMs,
        network_duration_ms: requestDurationMs !== null && serverDurationMs !== null ? Math.max(0, requestDurationMs - serverDurationMs) : null,
        server_duration_ms: serverDurationMs,
        provider_duration_ms: analysisMeta.providerDurationMs ?? null,
        postprocess_duration_ms: analysisMeta.postprocessDurationMs ?? null,
        image_size_bytes: analysisMeta.imageBytes ?? imageSizeBytes,
        image_width: sentImageSize?.width ?? null,
        image_height: sentImageSize?.height ?? null,
        provider_call_count: (analysisMeta.providerAttemptCount || 0) > 0 ? 1 : 0,
        provider_attempt_count: analysisMeta.providerAttemptCount ?? null,
        http_status: httpStatus,
        people_count: peopleCount,
        garment_count: garmentCount,
        model: analysisMeta.model || null,
        request_id: analysisMeta.requestId || null,
      });
    }
  };

  const choosePerson = (person: PersonAnalysis) => {
    setSelectedPersonId(person.id);
    setGarments(person.items || []);
    setOutfitEvaluation(person.outfitEvaluation || null);
    setExcludedGarments([]);
    setStage('review');
  };

  const toggleGarment = (index: number) => {
    setExcludedGarments((current) => current.includes(index)
      ? current.filter((itemIndex) => itemIndex !== index)
      : [...current, index]);
  };

  const updateGarment = (index: number, field: keyof Garment, value: string) => {
    setGarments((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (field === 'styles' || field === 'secondaryColors') {
        return { ...item, [field]: value.split(',').map((part) => part.trim()).filter(Boolean) };
      }
      return { ...item, [field]: value };
    }));
  };

  const selectFixedValue = (index: number, field: 'category' | 'subcategory', current: string) => {
    const options = field === 'category' ? FIXED_CATEGORIES : typesForCategory(garments[index]?.category || '');
    showNotice({ title: field === 'category' ? 'Categoría' : 'Tipo de prenda', message: 'Selecciona una opción', actions: options.map((option) => ({ label: option.charAt(0).toLocaleUpperCase('es') + option.slice(1), onPress: () => updateGarment(index, field, option) })) });
  };

  const cropGarment = async (item: Garment) => {
    if (!imageUri || !imageSize) return imageUri || '';
    const box = item.itemBox;
    const boxWidth = Math.max(0, box.xMax - box.xMin);
    const boxHeight = Math.max(0, box.yMax - box.yMin);
    if (boxWidth < 5 || boxHeight < 5) return imageUri;
    const paddingX = Math.max(8, boxWidth * 0.06);
    const paddingY = Math.max(8, boxHeight * 0.06);
    const xMin = Math.max(0, box.xMin - paddingX);
    const yMin = Math.max(0, box.yMin - paddingY);
    const xMax = Math.min(1000, box.xMax + paddingX);
    const yMax = Math.min(1000, box.yMax + paddingY);
    try {
      const displayRotation = [90, 180, 270].includes(item.displayRotation) ? item.displayRotation : 0;
      const cropped = await ImageManipulator.manipulateAsync(imageUri, [{ crop: {
        originX: Math.round((xMin / 1000) * imageSize.width),
        originY: Math.round((yMin / 1000) * imageSize.height),
        width: Math.max(1, Math.round(((xMax - xMin) / 1000) * imageSize.width)),
        height: Math.max(1, Math.round(((yMax - yMin) / 1000) * imageSize.height)),
      } }], { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG });
      if (!displayRotation) return cropped.uri;
      const rotated = await ImageManipulator.manipulateAsync(cropped.uri, [{ rotate: displayRotation }], { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG });
      console.log(`[Recorte] ${item.subcategory || item.category}: rotación del objeto aplicada=${displayRotation}°.`);
      return rotated.uri;
    } catch {
      return imageUri;
    }
  };

  const compareGarmentPhotos = async (candidateUri: string, savedUri: string): Promise<GarmentComparison> => {
    const startedAt = Date.now();
    const form = new FormData();
    form.append('candidate', { uri: candidateUri, name: 'candidate.jpg', type: 'image/jpeg' } as unknown as Blob);
    form.append('saved', { uri: savedUri, name: 'saved.jpg', type: 'image/jpeg' } as unknown as Blob);
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
    const response = await fetch(`${apiUrl}/compare-garments`, { method: 'POST', body: form });
    const payload = await response.json();
    const result = { ...payload, clientDurationMs: Date.now() - startedAt, httpStatus: response.status } as GarmentComparison;
    if (!response.ok) throw Object.assign(new Error(payload.error || 'No se han podido comparar las fotos.'), { comparison: result });
    return result;
  };

  const saveGarments = async () => {
    if (!imageUri || garments.length === 0 || saving) return;
    let includedGarments = garments.filter((_item, index) => !excludedGarments.includes(index));
    if (includedGarments.length === 0) {
      showNotice({ title: 'No hay prendas seleccionadas', message: 'Incluye al menos una prenda antes de guardar.' });
      return;
    }
    setSaving(true);
    const preparationStartedAt = Date.now();
    try {
      let croppedItems = await Promise.all(includedGarments.map(async (item, index) => ({
        ...item,
        id: `${Date.now()}-${index}`,
        imageUri: await cropGarment(item),
        wearCount: 1,
        scanFingerprint: {
          category: item.category,
          subcategory: item.subcategory,
          primaryColor: canonicalColor(item.primaryColor),
          brand: item.brand,
          pattern: item.pattern,
          fabricType: item.fabricType,
          styles: [...item.styles],
        },
      })));
      const preparationDurationMs = Date.now() - preparationStartedAt;
      const comparisonTargets = croppedItems.flatMap((candidate) => {
        const metadataCandidates = wardrobeItems
          .map((saved) => ({ saved, score: duplicateScore(candidate, saved) }))
          .filter(({ score }) => score >= 0.55)
          .sort((first, second) => second.score - first.score)
          .slice(0, 1);
        const closest = metadataCandidates[0];
        return closest ? [{ candidate, closest }] : [];
      });
      const comparisonsStartedAt = Date.now();
      const comparisonResults = await mapWithConcurrency(comparisonTargets, 2, async ({ candidate, closest }) => {
        try {
          const visual = await compareGarmentPhotos(candidate.imageUri, closest.saved.imageUri);
          const match = (visual.sameGarment && visual.confidence >= 0.6) || closest.score >= 0.8
            ? { candidateId: candidate.id, candidate, saved: closest.saved, bestImage: visual.bestImage || 'saved' } as DuplicateMatch
            : null;
          return { match, comparison: visual, failed: false };
        } catch (error) {
          const comparison = (error as Error & { comparison?: GarmentComparison }).comparison;
          const match = closest.score >= 0.85
            ? { candidateId: candidate.id, candidate, saved: closest.saved, bestImage: 'saved' } as DuplicateMatch
            : null;
          return { match, comparison, failed: true };
        }
      });
      const comparisonsDurationMs = Date.now() - comparisonsStartedAt;
      const comparisonMetas = comparisonResults.map((result) => result.comparison?._analysisMeta).filter((meta): meta is AnalysisMeta => Boolean(meta));
      const sumMetric = (values: Array<number | null | undefined>) => values.reduce<number>((total, value) => total + (value || 0), 0);
      const requestDurationMs = sumMetric(comparisonResults.map((result) => result.comparison?.clientDurationMs));
      const serverDurationMs = sumMetric(comparisonMetas.map((meta) => meta.serverDurationMs));
      recordAnalysisRun({
        analysis_type: 'duplicate_batch',
        status: comparisonResults.some((result) => result.failed) ? 'failed' : 'completed',
        client_duration_ms: comparisonsDurationMs,
        preparation_duration_ms: preparationDurationMs,
        request_duration_ms: requestDurationMs,
        network_duration_ms: Math.max(0, requestDurationMs - serverDurationMs),
        server_duration_ms: serverDurationMs,
        provider_duration_ms: sumMetric(comparisonMetas.map((meta) => meta.providerDurationMs)),
        image_size_bytes: sumMetric(comparisonMetas.map((meta) => (meta.candidateBytes || 0) + (meta.savedBytes || 0))),
        comparison_count: comparisonTargets.length,
        comparison_failure_count: comparisonResults.filter((result) => result.failed).length,
        cache_hit_count: comparisonMetas.filter((meta) => meta.cacheHit).length,
        provider_call_count: comparisonMetas.filter((meta) => !meta.cacheHit && (meta.providerAttemptCount || 0) > 0).length,
        provider_attempt_count: sumMetric(comparisonMetas.map((meta) => meta.providerAttemptCount)),
        model: comparisonMetas.find((meta) => meta.model)?.model || null,
      });
      const visualMatches = comparisonResults.map((result) => result.match).filter((match): match is DuplicateMatch => match !== null);
      if (visualMatches.length > 0) {
        setSaving(false);
        setDuplicateReview({
          croppedItems,
          appearanceItems: croppedItems,
          matchedGarmentIds: {},
          outfit: { imageUri, evaluation: outfitEvaluation, createdAt: photoDate || new Date().toISOString() },
          matches: visualMatches,
          wornItemIds: [],
          updatedItems: [],
        });
        setDuplicateIndex(0);
        setStage('duplicates');
        return;
      }
      await onSave(croppedItems, [], [], { imageUri, evaluation: outfitEvaluation, createdAt: photoDate || new Date().toISOString() }, croppedItems, {});
    } finally {
      setSaving(false);
    }
  };

  const renderPeoplePicker = () => <View style={styles.peoplePicker}>
    <View style={styles.peoplePickerIcon}><Feather name="users" size={20} color={COLORS.sageDark} /></View>
    <Text style={styles.peoplePickerTitle}>¿Cuál eres tú?</Text>
    <Text style={styles.peoplePickerText}>Hemos encontrado {people.length} personas. Elige cuál de sus outfits quieres guardar.</Text>
    {people.map((person) => {
      const selected = selectedPersonId === person.id;
      return <TouchableOpacity key={person.id} style={[styles.personOption, selected && styles.personOptionSelected]} onPress={() => choosePerson(person)}>
        <View style={[styles.personAvatar, selected && styles.personAvatarSelected]}>{faceThumbnails[person.id] ? <Image source={{ uri: faceThumbnails[person.id] }} style={styles.faceThumbnail} /> : <Text style={[styles.personAvatarText, selected && styles.personAvatarTextSelected]}>{person.id}</Text>}</View>
        <View style={styles.personCopy}><Text style={styles.personTitle}>Persona {person.id}</Text><Text style={styles.personMeta}>{person.position} · {person.items.length} prendas</Text></View>
        <Feather name={selected ? 'check-circle' : 'circle'} size={21} color={selected ? COLORS.sageDark : '#AAA39C'} />
      </TouchableOpacity>;
    })}
  </View>;

  const renderOutfitEvaluation = () => outfitEvaluation ? <View style={styles.outfitEvaluation}>
    <View style={styles.outfitEvaluationHead}><View style={{ flex: 1 }}><Text style={styles.evaluationEyebrow}>VALORACIÓN DEL OUTFIT</Text><Text style={styles.evaluationTitle}>Cómo funciona tu conjunto</Text></View>{showOutfitScore && <View style={styles.evaluationScore}><Text style={styles.evaluationScoreValue}>{Math.round(outfitEvaluation.score)}</Text><Text style={styles.evaluationScoreMax}>/100</Text></View>}</View>
    <Text style={styles.evaluationSummary}>{outfitEvaluation.summary}</Text>
    {outfitEvaluation.strengths?.length > 0 && <View style={styles.evaluationBlock}><Text style={styles.evaluationBlockTitle}>Lo que funciona</Text>{outfitEvaluation.strengths.map((text, index) => <View style={styles.evaluationRow} key={`strength-${index}`}><Feather name="check-circle" size={15} color={COLORS.sageDark} /><Text style={styles.evaluationRowText}>{text}</Text></View>)}</View>}
    {showImprovementPoints && outfitEvaluation.improvements?.length > 0 && <View style={styles.evaluationBlock}><Text style={styles.evaluationBlockTitle}>Podría mejorar</Text>{outfitEvaluation.improvements.map((text, index) => <View style={styles.evaluationRow} key={`improvement-${index}`}><Feather name="trending-up" size={15} color={COLORS.clay} /><Text style={styles.evaluationRowText}>{text}</Text></View>)}</View>}
    {showImprovementPoints && outfitEvaluation.suggestions?.length > 0 && <View style={styles.evaluationBlock}><Text style={styles.evaluationBlockTitle}>Ideas rápidas</Text>{outfitEvaluation.suggestions.map((text, index) => <View style={styles.evaluationRow} key={`suggestion-${index}`}><Feather name="plus" size={15} color={COLORS.muted} /><Text style={styles.evaluationRowText}>{text}</Text></View>)}</View>}
  </View> : null;

  const renderReview = () => <View style={styles.results}>
    <View style={{ backgroundColor: '#F0F3EC', borderRadius: 23, padding: 16, marginBottom: 22, borderWidth: 1, borderColor: '#DCE5D7' }}>
      <TouchableOpacity activeOpacity={0.75} onPress={() => setEvaluationExpanded((expanded) => !expanded)} style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginRight: 10 }}><Feather name="star" size={15} color={COLORS.sageDark} /></View><View style={{ flex: 1 }}><Text style={styles.evaluationEyebrow}>PRIMERA VISTA</Text><Text style={styles.evaluationTitle}>Valoración del outfit</Text></View><Feather name={evaluationExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={COLORS.sageDark} /></TouchableOpacity>
      {evaluationExpanded && <View style={{ marginTop: 13 }}>{renderOutfitEvaluation()}</View>}
    </View>
    <View style={{ backgroundColor: '#FBFAF8', borderRadius: 23, padding: 16, borderWidth: 1, borderColor: COLORS.line }}>
      <TouchableOpacity activeOpacity={0.75} onPress={() => setGarmentsExpanded((expanded) => !expanded)} style={styles.resultsHead}><View><Text style={styles.evaluationEyebrow}>DETALLE</Text><Text style={styles.resultsTitle}>{garments.length} prendas detectadas</Text></View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><View style={styles.betaBadge}><Text style={styles.betaText}>BETA</Text></View><Feather name={garmentsExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={COLORS.sageDark} /></View></TouchableOpacity>
      {garmentsExpanded && <>
      <Text style={styles.reviewHint}>Revisa, corrige u omite lo que necesites antes de guardar.</Text>
    {garments.map((item, index) => {
      const excluded = excludedGarments.includes(index);
      return <View key={`garment-${index}`} style={[styles.editCard, excluded && styles.editCardExcluded]}>
        <View style={[styles.editCardHead, excluded && styles.editCardHeadCollapsed]}>
          {!excluded && <View style={styles.resultNumber}><Text style={styles.resultNumberText}>{index + 1}</Text></View>}
          <Text style={styles.editCardTitle}>{garmentTitle(item)}</Text>
          <TouchableOpacity style={[styles.includeControl, excluded && styles.includeControlExcluded]} onPress={() => toggleGarment(index)}>
            <Feather name={excluded ? 'eye-off' : 'check'} size={13} color={excluded ? COLORS.muted : COLORS.sageDark} />
            <Text style={[styles.includeControlText, excluded && styles.includeControlTextExcluded]}>{excluded ? 'Omitida' : 'Incluida'}</Text>
          </TouchableOpacity>
        </View>
        {!excluded && <>
        <View style={styles.fieldRow}>
          <View style={styles.fieldHalf}><Text style={styles.fieldLabel}>CATEGORÍA</Text><TouchableOpacity disabled={excluded} onPress={() => selectFixedValue(index, 'category', item.category)} style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}><Text style={{ color: COLORS.ink, fontSize: 13, flex: 1 }}>{item.category}</Text><Feather name="chevron-down" size={16} color={COLORS.muted} /></TouchableOpacity></View>
          <View style={styles.fieldHalf}><Text style={styles.fieldLabel}>TIPO</Text><TouchableOpacity disabled={excluded} onPress={() => selectFixedValue(index, 'subcategory', item.subcategory)} style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}><Text style={{ color: COLORS.ink, fontSize: 13, flex: 1 }}>{item.subcategory}</Text><Feather name="chevron-down" size={16} color={COLORS.muted} /></TouchableOpacity></View>
        </View>
        <Text style={styles.fieldLabel}>COLOR PRINCIPAL</Text><TextInput editable={!excluded} value={item.primaryColor} onChangeText={(value) => updateGarment(index, 'primaryColor', value)} style={styles.fieldInput} />
        <Text style={styles.fieldLabel}>MARCA VISIBLE (OPCIONAL)</Text><TextInput editable={!excluded} value={item.brand || ''} onChangeText={(value) => updateGarment(index, 'brand', value)} placeholder="No identificada" placeholderTextColor="#AAA39C" style={styles.fieldInput} />
        <View style={styles.fieldRow}>
          <View style={styles.fieldHalf}><Text style={styles.fieldLabel}>ESTILO</Text><TextInput editable={!excluded} value={item.styles.join(', ')} onChangeText={(value) => updateGarment(index, 'styles', value)} style={styles.fieldInput} /></View>
        </View>
        </>}
      </View>;
    })}
    <TouchableOpacity style={[styles.saveButton, saving && styles.buttonDisabled]} onPress={saveGarments} disabled={saving}>
      {saving ? <ActivityIndicator color={COLORS.white} /> : <Feather name="check" size={19} color={COLORS.white} />}<Text style={styles.saveButtonText}>{saving ? 'Preparando prendas…' : `Guardar ${garments.length - excludedGarments.length} prendas`}</Text>
    </TouchableOpacity>
      </>}
    </View>
  </View>;

  const resolveDuplicate = (sameGarment: boolean) => {
    if (!duplicateReview) return;
    const currentMatch = duplicateReview.matches[duplicateIndex];
    const previousUpdate = duplicateReview.updatedItems.find((item) => item.id === currentMatch.saved.id) || currentMatch.saved;
    const mergedItem = mergeScans(previousUpdate, currentMatch.candidate, currentMatch.bestImage);
    const nextReview: DuplicateReview = sameGarment ? {
      ...duplicateReview,
      croppedItems: duplicateReview.croppedItems.filter((item) => item.id !== currentMatch.candidateId),
      matchedGarmentIds: { ...duplicateReview.matchedGarmentIds, [currentMatch.candidateId]: currentMatch.saved.id },
      wornItemIds: [...duplicateReview.wornItemIds, currentMatch.saved.id],
      updatedItems: [...duplicateReview.updatedItems.filter((item) => item.id !== mergedItem.id), mergedItem],
    } : duplicateReview;
    const nextIndex = duplicateIndex + 1;
    if (nextIndex < duplicateReview.matches.length) {
      setDuplicateReview(nextReview);
      setDuplicateIndex(nextIndex);
      return;
    }
    setDuplicateReview(null);
    setDuplicateIndex(0);
    void onSave(nextReview.croppedItems, nextReview.wornItemIds, nextReview.updatedItems, nextReview.outfit, nextReview.appearanceItems, nextReview.matchedGarmentIds);
  };

  if (stage === 'duplicates' && duplicateReview) {
    const match = duplicateReview.matches[duplicateIndex];
    return <><ScrollView contentContainerStyle={styles.duplicateScroll} showsVerticalScrollIndicator={false}>
      <TouchableOpacity style={styles.backButton} onPress={() => { setDuplicateReview(null); setDuplicateIndex(0); setStage('review'); }}><Feather name="arrow-left" size={19} color={COLORS.ink} /><Text style={styles.backButtonText}>Volver a revisar</Text></TouchableOpacity>
      <Text style={styles.eyebrow}>POSIBLE COINCIDENCIA</Text>
      <Text style={styles.duplicateTitle}>¿Es la misma prenda?</Text>
      <Text style={styles.duplicateIntro}>Compara los detalles de ambas fotos. Si es la misma, sumaremos un uso sin duplicarla.</Text>
      <View style={styles.duplicateCounter}><Text style={styles.duplicateCounterText}>Coincidencia {duplicateIndex + 1} de {duplicateReview.matches.length}</Text></View>
      <View style={styles.comparisonRow}>
        <View style={styles.comparisonColumn}><Text style={styles.comparisonLabel}>NUEVA FOTO</Text><TouchableOpacity activeOpacity={0.9} onPress={() => setComparisonFullScreenImage(match.candidate.imageUri)}><View><Image source={{ uri: match.candidate.imageUri }} style={styles.comparisonImage} />{match.bestImage === 'candidate' && <View style={styles.bestPhotoBadge}><Feather name="star" size={9} color={COLORS.white} /><Text style={styles.bestPhotoBadgeText}>Mejor foto</Text></View>}</View></TouchableOpacity><Text style={styles.comparisonName}>{garmentTitle(match.candidate)}</Text></View>
        <View style={styles.comparisonDivider}><Text style={styles.comparisonVs}>VS</Text></View>
        <View style={styles.comparisonColumn}><Text style={styles.comparisonLabel}>EN TU ARMARIO</Text><TouchableOpacity activeOpacity={0.9} onPress={() => setComparisonFullScreenImage(match.saved.imageUri)}><View><Image source={{ uri: match.saved.imageUri }} style={styles.comparisonImage} />{match.bestImage === 'saved' && <View style={styles.bestPhotoBadge}><Feather name="star" size={9} color={COLORS.white} /><Text style={styles.bestPhotoBadgeText}>Mejor foto</Text></View>}</View></TouchableOpacity><Text style={styles.comparisonName}>{garmentTitle(match.saved)}</Text><Text style={styles.comparisonUses}>{match.saved.wearCount || 1} {(match.saved.wearCount || 1) === 1 ? 'uso' : 'usos'}</Text></View>
      </View>
      <View style={styles.duplicateClues}><Feather name="search" size={17} color={COLORS.sageDark} /><Text style={styles.duplicateCluesText}>Fíjate en el corte, costuras, logotipo, estampado, tipo de tejido y textura.</Text></View>
      <TouchableOpacity style={styles.sameGarmentButton} onPress={() => resolveDuplicate(true)}><Feather name="repeat" size={18} color={COLORS.white} /><View><Text style={styles.sameGarmentButtonTitle}>Es la misma</Text><Text style={styles.sameGarmentButtonText}>Sumar un uso y no duplicar</Text></View></TouchableOpacity>
      <TouchableOpacity style={styles.differentGarmentButton} onPress={() => resolveDuplicate(false)}><Feather name="copy" size={18} color={COLORS.sageDark} /><View><Text style={styles.differentGarmentButtonTitle}>Es distinta</Text><Text style={styles.differentGarmentButtonText}>Guardar como una prenda nueva</Text></View></TouchableOpacity>
    </ScrollView><Modal visible={comparisonFullScreenImage !== null} transparent animationType="fade" onRequestClose={() => setComparisonFullScreenImage(null)}><View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}><TouchableOpacity onPress={() => setComparisonFullScreenImage(null)} style={{ position: 'absolute', top: 52, right: 20, zIndex: 2, width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }}><Feather name="x" size={22} color={COLORS.ink} /></TouchableOpacity>{comparisonFullScreenImage && <Image source={{ uri: comparisonFullScreenImage }} resizeMode="contain" style={{ width: '100%', height: '100%' }} />}</View></Modal></>;
  }

  if (stage === 'person') return <ScrollView contentContainerStyle={styles.stepScroll} showsVerticalScrollIndicator={false}>
    <TouchableOpacity style={styles.backButton} onPress={() => setStage('upload')}><Feather name="arrow-left" size={19} color={COLORS.ink} /><Text style={styles.backButtonText}>Volver</Text></TouchableOpacity>
    {imageUri && <Image source={{ uri: imageUri }} style={styles.stepImage} />}
    {renderPeoplePicker()}
  </ScrollView>;

  if (stage === 'review') return <ScrollView contentContainerStyle={styles.stepScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    <PreparationLoading visible={saving} />
    <TouchableOpacity style={styles.backButton} onPress={() => setStage(people.length > 1 ? 'person' : 'upload')}><Feather name="arrow-left" size={19} color={COLORS.ink} /><Text style={styles.backButtonText}>{people.length > 1 ? 'Cambiar persona' : 'Volver'}</Text></TouchableOpacity>
    <View style={styles.reviewHero}>{imageUri && <Image source={{ uri: imageUri }} style={styles.reviewImage} />}<View style={styles.reviewHeroCopy}><Text style={styles.eyebrow}>REVISIÓN</Text><Text style={styles.reviewHeroTitle}>Revisa tu outfit</Text><Text style={styles.reviewHeroText}>Confirma los datos antes de añadirlos al armario.</Text></View></View>
    {youngChildDetected && <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#F2E2DA', borderRadius: 16, padding: 13, marginTop: 10 }}><Feather name="info" size={17} color={COLORS.clay} /><Text style={{ flex: 1, color: COLORS.ink, fontSize: 11, lineHeight: 16 }}>Hemos detectado un bebé o niño muy pequeño en la imagen. Sus prendas no se analizan ni se añaden al armario.</Text></View>}
    {renderReview()}
  </ScrollView>;

  return <ScrollView contentContainerStyle={styles.addScroll} showsVerticalScrollIndicator={false}>
    <AnalysisLoading visible={analyzing} />
    <View style={styles.addHeader}>
      <Text style={styles.eyebrow}>NUEVO OUTFIT</Text>
      <Text style={styles.title}>Añade una foto</Text>
      <Text style={styles.addIntro}>Elige una imagen donde se vea bien tu conjunto. Más adelante separaremos y clasificaremos sus prendas.</Text>
    </View>

    {noOutfitFound ? <View style={{ backgroundColor: COLORS.white, borderRadius: 24, padding: 22, alignItems: 'center', borderWidth: 1, borderColor: COLORS.line }}><View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: '#F2E2DA', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}><Feather name={photoSource === 'camera' ? 'camera' : 'image'} size={25} color={COLORS.clay} /></View><Text style={{ color: COLORS.ink, fontSize: 20, fontWeight: '700', textAlign: 'center' }}>No vemos un outfit en primer plano</Text><Text style={{ color: COLORS.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 10 }}>Prueba con una foto donde la persona protagonista aparezca más cerca y sus prendas se vean con claridad.</Text><TouchableOpacity style={[styles.primaryButton, { marginTop: 20 }]} onPress={() => { setNoOutfitFound(false); if (photoSource === 'camera') void takePhoto(); else void chooseFromGallery(); }}><Feather name="refresh-cw" size={17} color={COLORS.white} /><Text style={styles.primaryButtonText}>{photoSource === 'camera' ? 'Abrir cámara de nuevo' : 'Elegir otra foto'}</Text></TouchableOpacity></View> : imageUri ? <>
      <View style={styles.previewFrame}>
        <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="cover" />
        <TouchableOpacity style={styles.removeImage} onPress={() => setImageUri(null)} accessibilityLabel="Descartar foto">
          <Feather name="x" size={19} color={COLORS.ink} />
        </TouchableOpacity>
      </View>
      <View style={styles.imageReady}>
        <View style={styles.readyIcon}><Feather name="check" size={16} color={COLORS.sageDark} /></View>
        <View style={styles.readyCopy}><Text style={styles.readyTitle}>Foto preparada</Text><Text style={styles.readyText}>En el siguiente paso analizaremos las prendas.</Text></View>
      </View>
      {askForPhotoDate && <View style={{ backgroundColor: '#F0F3EC', borderRadius: 16, padding: 14, marginTop: 12 }}><Text style={{ color: COLORS.ink, fontSize: 13, fontWeight: '700' }}>¿Cuándo llevaste este outfit?</Text><Text style={{ color: COLORS.muted, fontSize: 11, marginTop: 4, marginBottom: 10 }}>No hemos encontrado la fecha original de la foto. Es opcional.</Text><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><TextInput value={manualPhotoDate} onChangeText={(value) => { setManualPhotoDate(value); const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parsePhotoDate(`${value}T12:00:00`) : null; setPhotoDate(parsed); }} placeholder="AAAA-MM-DD" placeholderTextColor="#AAA39C" style={[styles.fieldInput, { flex: 1, marginBottom: 0 }]} /><TouchableOpacity onPress={() => setAskForPhotoDate(false)}><Text style={{ color: COLORS.sageDark, fontSize: 11, fontWeight: '800' }}>Omitir</Text></TouchableOpacity></View></View>}
      <TouchableOpacity style={[styles.analyzeButton, analyzing && styles.buttonDisabled]} onPress={analyzeOutfit} disabled={analyzing}>
        {analyzing ? <ActivityIndicator color={COLORS.white} /> : <Feather name="zap" size={18} color={COLORS.white} />}
        <Text style={styles.analyzeButtonText}>{analyzing ? 'Analizando outfit…' : 'Analizar prendas'}</Text>
      </TouchableOpacity>
      {people.length === 0 && !analyzing && imageUri && <Text style={styles.analysisNote}>Pulsa “Analizar prendas” para detectar a las personas y sus outfits.</Text>}
      <TouchableOpacity style={styles.secondaryButton} onPress={chooseFromGallery}>
        <Feather name="image" size={18} color={COLORS.sageDark} /><Text style={styles.secondaryButtonText}>Elegir otra foto</Text>
      </TouchableOpacity>
    </> : <TouchableOpacity style={styles.galleryPicker} onPress={chooseFromGallery} activeOpacity={0.82}>
      <View style={styles.galleryIcon}><Feather name="image" size={30} color={COLORS.sageDark} /></View>
      <Text style={styles.galleryTitle}>Elegir de la galería</Text>
      <Text style={styles.galleryText}>JPG, PNG o HEIC</Text>
      <View style={styles.galleryAction}><Text style={styles.galleryActionText}>Seleccionar foto</Text><Feather name="arrow-right" size={18} color={COLORS.white} /></View>
    </TouchableOpacity>}
    {!noOutfitFound && <TouchableOpacity style={styles.secondaryButton} onPress={takePhoto}>
      <Feather name="camera" size={18} color={COLORS.sageDark} /><Text style={styles.secondaryButtonText}>{imageUri ? 'Hacer otra foto' : 'Hacer una foto ahora'}</Text>
    </TouchableOpacity>}
    <View style={styles.privacyNote}><Feather name="lock" size={14} color={COLORS.muted}/><Text style={styles.privacyText}>La foto solo se envía para analizarla cuando pulsas “Analizar prendas”.</Text></View>
  </ScrollView>;
}

function Wardrobe({ items, initialCategory, onDelete, onMerge, onUpdate }: { items: SavedGarment[]; initialCategory: string; onDelete: (id: string) => void; onMerge: (keptId: string, mergedId: string) => void; onUpdate: (item: SavedGarment) => void }) {
  const { showNotice } = useNotice();
  const [selectedCategories, setSelectedCategories] = useState<string[]>(initialCategory === 'todas' ? [] : [initialCategory]);
  const [selectedItem, setSelectedItem] = useState<SavedGarment | null>(null);
  const [mergeSource, setMergeSource] = useState<SavedGarment | null>(null);
  const [editingItem, setEditingItem] = useState<SavedGarment | null>(null);
  const [fixedPicker, setFixedPicker] = useState<any>(null);
  const selectEditingFixed = (field: 'category' | 'subcategory') => {
    if (!editingItem) return;
    setFixedPicker(field);
  };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('');
  if (items.length === 0) return <EmptyScreen tab="armario" />;

  const categoryCounts = items.reduce<Record<string, { label: string; count: number }>>((counts, item) => {
    const { key, label } = normalizedCategory(item.category);
    counts[key] = { label, count: (counts[key]?.count || 0) + 1 };
    return counts;
  }, {});
  const categories = Object.entries(categoryCounts).sort(([, first], [, second]) => first.label.localeCompare(second.label, 'es'));
  const orderedCategories = selectedCategories.length === 0 ? categories : [...categories].sort(([firstKey], [secondKey]) => (selectedCategories.includes(firstKey) ? -1 : selectedCategories.includes(secondKey) ? 1 : 0));
  const makeOptions = (values: string[]) => Array.from(new Map(values.filter(Boolean).map((value) => [value.trim().toLocaleLowerCase('es'), value.trim()])).entries()).sort(([, first], [, second]) => first.localeCompare(second, 'es'));
  const colorOptions = makeOptions(items.map((item) => item.primaryColor));
  const typeOptions = makeOptions(items.map((item) => item.subcategory || item.category));
  const styleOptions = makeOptions(items.flatMap((item) => item.styles));
  const activeFilterCount = [selectedColor, selectedType, selectedStyle].filter(Boolean).length;
  const visibleItems = items.filter((item) => {
    const matchesCategory = selectedCategories.length === 0 || selectedCategories.includes(normalizedCategory(item.category).key);
    const matchesColor = !selectedColor || item.primaryColor.trim().toLocaleLowerCase('es') === selectedColor;
    const matchesType = !selectedType || (item.subcategory || item.category).trim().toLocaleLowerCase('es') === selectedType;
    const matchesStyle = !selectedStyle || item.styles.some((style) => style.trim().toLocaleLowerCase('es') === selectedStyle);
    return matchesCategory && matchesColor && matchesType && matchesStyle;
  });
  const clearFilters = () => {
    setSelectedColor('');
    setSelectedType('');
    setSelectedStyle('');
  };
  const confirmDelete = (item: SavedGarment) => showNotice({ title: 'Eliminar prenda', message: `¿Quieres eliminar “${garmentTitle(item)}” de tu armario? Esta acción no se puede deshacer.`, actions: [{ label: 'Cancelar' }, { label: 'Eliminar', destructive: true, onPress: () => { setSelectedItem(null); onDelete(item.id); } }] });
  const confirmMerge = (source: SavedGarment, target: SavedGarment) => showNotice({ title: 'Fusionar prendas', message: `Se conservarán la foto y los datos de “${garmentTitle(source)}” y se sumarán los ${(source.wearCount || 1) + (target.wearCount || 1)} usos de ambas fichas.`, actions: [{ label: 'Cancelar' }, { label: 'Fusionar', onPress: () => { setMergeSource(null); onMerge(source.id, target.id); } }] });
  const rotateWardrobeImage = async (item: SavedGarment) => {
    try {
      const rotated = await ImageManipulator.manipulateAsync(item.imageUri, [{ rotate: 90 }], { compress: 0.84, format: ImageManipulator.SaveFormat.JPEG });
      const updatedItem = { ...item, imageUri: rotated.uri };
      setSelectedItem(updatedItem);
      onUpdate(updatedItem);
    } catch {
      showNotice({ title: 'No hemos podido girar la imagen', message: 'Vuelve a intentarlo en unos segundos.' });
    }
  };
  const renderFilterOptions = (options: [string, string][], selected: string, onSelect: (value: string) => void) => <View style={styles.filterOptions}>
    {options.map(([key, label]) => <TouchableOpacity key={key} style={[styles.filterOption, selected === key && styles.filterOptionActive]} onPress={() => onSelect(selected === key ? '' : key)}>
      <Text style={[styles.filterOptionText, selected === key && styles.filterOptionTextActive]}>{label}</Text>
      {selected === key ? <Feather name="check" size={13} color={COLORS.white} /> : null}
    </TouchableOpacity>)}
  </View>;

  return <ScrollView contentContainerStyle={styles.wardrobeScroll} showsVerticalScrollIndicator={false}>
    <View style={styles.wardrobeHeader}><Text style={styles.eyebrow}>MI COLECCIÓN</Text><Text style={styles.title}>Tu armario</Text><Text style={styles.addIntro}>{items.length} prendas guardadas en esta sesión.</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryFilters}>
      <TouchableOpacity style={[styles.categoryFilter, selectedCategories.length === 0 && styles.categoryFilterActive]} onPress={() => setSelectedCategories([])}>
        <Text style={[styles.categoryFilterText, selectedCategories.length === 0 && styles.categoryFilterTextActive]}>Todas</Text><Text style={[styles.categoryFilterCount, selectedCategories.length === 0 && styles.categoryFilterTextActive]}>{items.length}</Text>
      </TouchableOpacity>
      {orderedCategories.map(([key, category]) => <TouchableOpacity key={key} style={[styles.categoryFilter, selectedCategories.includes(key) && styles.categoryFilterActive]} onPress={() => setSelectedCategories((current) => current.includes(key) ? current.filter((categoryKey) => categoryKey !== key) : [...current, key])}>
        <Text style={[styles.categoryFilterText, selectedCategories.includes(key) && styles.categoryFilterTextActive]}>{category.label}</Text><Text style={[styles.categoryFilterCount, selectedCategories.includes(key) && styles.categoryFilterTextActive]}>{category.count}</Text>
      </TouchableOpacity>)}
    </ScrollView>
    <View style={styles.filterSummary}><Text style={styles.filteredCount}>{visibleItems.length} {visibleItems.length === 1 ? 'prenda' : 'prendas'}</Text><TouchableOpacity style={[styles.filterButton, activeFilterCount > 0 && styles.filterButtonActive]} onPress={() => setFiltersOpen(true)}><Feather name="sliders" size={15} color={activeFilterCount > 0 ? COLORS.white : COLORS.sageDark} /><Text style={[styles.filterButtonText, activeFilterCount > 0 && styles.filterButtonTextActive]}>Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</Text></TouchableOpacity></View>
    <View style={styles.wardrobeGrid}>{visibleItems.map((item) => <TouchableOpacity key={item.id} style={styles.wardrobeItem} activeOpacity={0.84} onPress={() => setSelectedItem(item)}>
      <Image source={{ uri: item.imageUri }} style={styles.wardrobeImage} />
      <View style={styles.wardrobeInfo}><Text style={styles.wardrobeName}>{garmentTitle(item)}</Text><Text style={styles.wardrobeMeta}>{item.primaryColor} · {item.pattern}</Text><Text style={styles.wardrobeMaterial}>{item.fabricType} · {item.texture}</Text><View style={styles.wardrobeCardFooter}><View style={styles.stylePill}><Text style={styles.stylePillText}>{item.styles[0] || 'Sin estilo'}</Text></View><View style={styles.wearBadge}><Text style={styles.wearBadgeText}>{item.wearCount || 1}×</Text></View></View></View>
    </TouchableOpacity>)}</View>
    <Modal visible={filtersOpen} transparent animationType="slide" onRequestClose={() => setFiltersOpen(false)}>
      <View style={styles.filterModalBackdrop}>
        <TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setFiltersOpen(false)} />
        <View style={styles.filterModal}>
          <View style={styles.filterModalHead}><View><Text style={styles.filterModalTitle}>Filtrar armario</Text><Text style={styles.filterModalSubtitle}>Combina los filtros que necesites</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setFiltersOpen(false)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.filterGroupTitle}>COLOR</Text>{renderFilterOptions(colorOptions, selectedColor, setSelectedColor)}
            <Text style={styles.filterGroupTitle}>TIPO DE PRENDA</Text>{renderFilterOptions(typeOptions, selectedType, setSelectedType)}
            <Text style={styles.filterGroupTitle}>ESTILO</Text>{renderFilterOptions(styleOptions, selectedStyle, setSelectedStyle)}
          </ScrollView>
          <View style={styles.filterActions}><TouchableOpacity style={styles.clearFilterButton} onPress={clearFilters}><Text style={styles.clearFilterText}>Limpiar</Text></TouchableOpacity><TouchableOpacity style={styles.applyFilterButton} onPress={() => setFiltersOpen(false)}><Text style={styles.applyFilterText}>Ver {visibleItems.length} {visibleItems.length === 1 ? 'prenda' : 'prendas'}</Text></TouchableOpacity></View>
        </View>
      </View>
    </Modal>
    <Modal visible={selectedItem !== null} transparent animationType="slide" onRequestClose={() => setSelectedItem(null)}>
      <View style={styles.detailBackdrop}>
        <TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setSelectedItem(null)} />
        {selectedItem && <View style={styles.garmentDetail}>
          <View style={styles.filterModalHead}><View><Text style={styles.eyebrow}>DETALLE DE PRENDA</Text><Text style={styles.garmentDetailTitle}>{garmentTitle(selectedItem)}</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setSelectedItem(null)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View>
          <Image source={{ uri: selectedItem.imageUri }} style={styles.garmentDetailImage} />
          <View style={styles.wearSummary}><View style={styles.wearSummaryIcon}><Feather name="repeat" size={21} color={COLORS.sageDark} /></View><View><Text style={styles.wearSummaryCount}>{selectedItem.wearCount || 1} {(selectedItem.wearCount || 1) === 1 ? 'uso' : 'usos'}</Text><Text style={styles.wearSummaryText}>Te la has puesto {(selectedItem.wearCount || 1) === 1 ? 'una vez' : `${selectedItem.wearCount} veces`}</Text></View></View>
          <Text style={styles.garmentDetailMeta}>{selectedItem.primaryColor} · {selectedItem.pattern} · {selectedItem.fabricType} · {selectedItem.texture}{hasUsefulValue(selectedItem.materialEstimate) ? ` · Composición aparente: ${selectedItem.materialEstimate}` : ''}</Text>
          <View style={styles.detailActions}><TouchableOpacity style={styles.editGarmentButton} onPress={() => { setEditingItem({ ...selectedItem, styles: [...selectedItem.styles], secondaryColors: [...selectedItem.secondaryColors] }); setSelectedItem(null); }}><Feather name="edit-2" size={17} color={COLORS.white} /><Text style={styles.editGarmentButtonText}>Editar nombre y características</Text></TouchableOpacity><TouchableOpacity style={styles.rotateImageButton} onPress={() => void rotateWardrobeImage(selectedItem)}><Feather name="rotate-cw" size={17} color={COLORS.sageDark} /><Text style={styles.mergeButtonText}>Girar</Text></TouchableOpacity><TouchableOpacity style={styles.mergeButton} onPress={() => { setMergeSource(selectedItem); setSelectedItem(null); }}><Feather name="git-merge" size={17} color={COLORS.sageDark} /><Text style={styles.mergeButtonText}>Fusionar</Text></TouchableOpacity><TouchableOpacity style={styles.deleteButton} onPress={() => confirmDelete(selectedItem)}><Feather name="trash-2" size={17} color="#A54E43" /><Text style={styles.deleteButtonText}>Eliminar</Text></TouchableOpacity></View>
        </View>}
      </View>
    </Modal>
    <Modal visible={mergeSource !== null} transparent animationType="slide" onRequestClose={() => setMergeSource(null)}>
      <View style={styles.detailBackdrop}>
        <TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setMergeSource(null)} />
        {mergeSource && <View style={styles.mergeSheet}>
          <View style={styles.filterModalHead}><View><Text style={styles.eyebrow}>FUSIONAR PRENDAS</Text><Text style={styles.filterModalTitle}>Elige la ficha duplicada</Text><Text style={styles.filterModalSubtitle}>Conservaremos “{garmentTitle(mergeSource)}” como ficha principal.</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setMergeSource(null)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.mergeList}>
            {items.filter((item) => item.id !== mergeSource.id).map((item) => <TouchableOpacity key={item.id} style={styles.mergeOption} onPress={() => confirmMerge(mergeSource, item)}><Image source={{ uri: item.imageUri }} style={styles.mergeOptionImage} /><View style={styles.mergeOptionCopy}><Text style={styles.mergeOptionTitle}>{garmentTitle(item)}</Text><Text style={styles.mergeOptionMeta}>{item.wearCount || 1} {(item.wearCount || 1) === 1 ? 'uso' : 'usos'} · {item.fabricType} · {item.texture}</Text></View><Feather name="chevron-right" size={19} color={COLORS.muted} /></TouchableOpacity>)}
            {items.length === 1 && <Text style={styles.noMergeOptions}>No hay otra prenda con la que fusionarla.</Text>}
          </ScrollView>
        </View>}
      </View>
    </Modal>
    <Modal visible={editingItem !== null} transparent animationType="slide" onRequestClose={() => setEditingItem(null)}>
      <View style={styles.detailBackdrop}>
        <TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setEditingItem(null)} />
        {editingItem && <View style={styles.editGarmentSheet}>
          <View style={styles.filterModalHead}><View><Text style={styles.eyebrow}>EDITAR PRENDA</Text><Text style={styles.filterModalTitle}>{garmentTitle(editingItem)}</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setEditingItem(null)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>NOMBRE PERSONALIZADO</Text><TextInput value={editingItem.customName || ''} onChangeText={(value) => setEditingItem({ ...editingItem, customName: value })} placeholder={garmentTitle({ ...editingItem, customName: '' })} placeholderTextColor="#AAA39C" style={styles.fieldInput} />
            <View style={styles.fieldRow}><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>CATEGORÍA</Text><TouchableOpacity onPress={() => selectEditingFixed('category')} style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}><Text style={{ color: COLORS.ink, fontSize: 13, flex: 1 }}>{editingItem.category}</Text><Feather name="chevron-down" size={16} color={COLORS.muted} /></TouchableOpacity></View><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>TIPO</Text><TouchableOpacity onPress={() => selectEditingFixed('subcategory')} style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}><Text style={{ color: COLORS.ink, fontSize: 13, flex: 1 }}>{editingItem.subcategory}</Text><Feather name="chevron-down" size={16} color={COLORS.muted} /></TouchableOpacity></View></View>
            <View style={styles.fieldRow}><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>COLOR</Text><TextInput value={editingItem.primaryColor} onChangeText={(value) => setEditingItem({ ...editingItem, primaryColor: value })} style={styles.fieldInput} /></View><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>MARCA</Text><TextInput value={editingItem.brand || ''} onChangeText={(value) => setEditingItem({ ...editingItem, brand: value })} placeholder="No identificada" placeholderTextColor="#AAA39C" style={styles.fieldInput} /></View></View>
            <View style={styles.fieldRow}><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>ESTILO</Text><TextInput value={editingItem.styles.join(', ')} onChangeText={(value) => setEditingItem({ ...editingItem, styles: value.split(',').map((part) => part.trim()).filter(Boolean) })} style={styles.fieldInput} /></View><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>ESTAMPADO</Text><TextInput value={editingItem.pattern} onChangeText={(value) => setEditingItem({ ...editingItem, pattern: value })} style={styles.fieldInput} /></View></View>
            <View style={styles.fieldRow}><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>TIPO DE TEJIDO</Text><TextInput value={editingItem.fabricType} onChangeText={(value) => setEditingItem({ ...editingItem, fabricType: value })} style={styles.fieldInput} /></View><View style={styles.fieldHalf}><Text style={styles.fieldLabel}>TEXTURA</Text><TextInput value={editingItem.texture} onChangeText={(value) => setEditingItem({ ...editingItem, texture: value })} style={styles.fieldInput} /></View></View>
            <Text style={styles.fieldLabel}>COMPOSICIÓN APARENTE (SECUNDARIA)</Text><TextInput value={editingItem.materialEstimate} onChangeText={(value) => setEditingItem({ ...editingItem, materialEstimate: value })} style={styles.fieldInput} />
          </ScrollView>
          <TouchableOpacity style={styles.saveEditButton} onPress={() => { onUpdate({ ...editingItem, customName: editingItem.customName?.trim() || undefined }); setEditingItem(null); }}><Feather name="check" size={18} color={COLORS.white} /><Text style={styles.saveEditButtonText}>Guardar cambios</Text></TouchableOpacity>
        </View>}
      </View>
    </Modal>
    <Modal visible={fixedPicker !== null} transparent animationType="fade" onRequestClose={() => setFixedPicker(null)}>
      <View style={styles.detailBackdrop}><TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setFixedPicker(null)} /><View style={styles.mergeSheet}><View style={styles.filterModalHead}><View><Text style={styles.eyebrow}>EDITAR PRENDA</Text><Text style={styles.filterModalTitle}>{fixedPicker === 'category' ? 'Categoría' : 'Tipo de prenda'}</Text><Text style={styles.filterModalSubtitle}>Selecciona una opción</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setFixedPicker(null)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View><ScrollView contentContainerStyle={styles.mergeList}>{(fixedPicker === 'category' ? FIXED_CATEGORIES : FIXED_TYPES).map((option) => { const selected = editingItem?.[fixedPicker] === option; return <TouchableOpacity key={option} style={[styles.mergeOption, selected && styles.categoryFilterActive]} onPress={() => { if (editingItem && fixedPicker) setEditingItem({ ...editingItem, [fixedPicker]: option }); setFixedPicker(null); }}><Text style={[styles.mergeOptionTitle, selected && styles.categoryFilterTextActive]}>{option.charAt(0).toLocaleUpperCase('es') + option.slice(1)}</Text>{selected && <Feather name="check" size={17} color={COLORS.white} />}</TouchableOpacity>; })}</ScrollView></View></View>
    </Modal>
  </ScrollView>;
}

type HomeCategory = { key: string; label: string; count: number; imageUris: string[] };
function OutfitHistoryCard({ outfit, onOpen, onDelete, showOutfitScore }: { outfit: SavedOutfit; onOpen: () => void; onDelete: () => void; showOutfitScore: boolean }) {
  const SwipeTouchable = TouchableOpacity as any;
  const translateX = useRef(new Animated.Value(0)).current;
  const startX = useRef(0);
  const horizontalGesture = useRef(false);
  const settleSwipe = (x: number) => x < -48
    ? Animated.timing(translateX, { toValue: -420, duration: 180, useNativeDriver: true }).start(onDelete)
    : Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
  const deleteControl = <TouchableOpacity onPress={onDelete} style={{ width: 92, height: 112, alignItems: 'center', justifyContent: 'center' }}><Feather name="trash-2" size={20} color={COLORS.white} /><Text style={{ color: COLORS.white, fontSize: 10, fontWeight: '800', marginTop: 5 }}>Eliminar</Text></TouchableOpacity>;
  return <View style={{ height: 112, maxHeight: 112, flexGrow: 0, flexShrink: 0, marginBottom: 11, borderRadius: 18, overflow: 'hidden', backgroundColor: '#C95F55', flexDirection: 'row', justifyContent: 'space-between' }}>{deleteControl}{deleteControl}<Animated.View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 112, transform: [{ translateX }] }}><SwipeTouchable activeOpacity={0.86} onTouchStart={(event: any) => { startX.current = event.nativeEvent.pageX; horizontalGesture.current = false; }} onTouchMove={(event: any) => { const distance = event.nativeEvent.pageX - startX.current; if (Math.abs(distance) > 12) { horizontalGesture.current = true; translateX.setValue(Math.max(-92, Math.min(92, distance))); } }} onTouchEnd={(event: any) => { if (horizontalGesture.current) settleSwipe(event.nativeEvent.pageX - startX.current); }} onPress={() => { if (!horizontalGesture.current) onOpen(); horizontalGesture.current = false; }} style={{ flex: 1, backgroundColor: COLORS.white, flexDirection: 'row' }}><Image source={{ uri: outfit.imageUri }} style={{ width: 96, height: 112, backgroundColor: COLORS.sand }} /><View style={{ flex: 1, padding: 13, justifyContent: 'center' }}><Text style={styles.cardTitle}>{new Date(outfit.createdAt).toLocaleDateString('es-ES')}</Text>{outfit.evaluation && <>{showOutfitScore && <Text style={{ color: COLORS.sageDark, fontSize: 19, fontWeight: '800', marginTop: 5 }}>{Math.round(outfit.evaluation.score)}/100</Text>}<Text numberOfLines={2} style={[styles.reviewHint, { marginTop: showOutfitScore ? 4 : 7, marginBottom: 0 }]}>{outfit.evaluation.summary}</Text></>}<Feather name="chevron-right" size={18} color={COLORS.muted} style={{ position: 'absolute', right: 12, top: 13 }} /></View></SwipeTouchable></Animated.View></View>;
}

function Outfits({ outfits, onDelete, onRestore, onDeletePermanent, showOutfitScore, showImprovementPoints }: { outfits: SavedOutfit[]; onDelete: (id: string) => void; onRestore: (outfit: SavedOutfit) => void; onDeletePermanent: (outfit: SavedOutfit) => Promise<void>; showOutfitScore: boolean; showImprovementPoints: boolean }) {
  const { showNotice } = useNotice();
  const [selectedOutfit, setSelectedOutfit] = useState<SavedOutfit | null>(null);
  const [fullScreenImage, setFullScreenImage] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'date' | 'score'>('date');
  const [recentlyDeleted, setRecentlyDeleted] = useState<SavedOutfit | null>(null);
  const deleteTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDeletion = useRef<SavedOutfit | null>(null);
  useEffect(() => () => { if (deleteTimeout.current) clearTimeout(deleteTimeout.current); }, []);
  if (outfits.length === 0 && !recentlyDeleted) return <EmptyScreen tab="outfits" />;
  const orderedOutfits = [...outfits].sort((first, second) => !showOutfitScore || sortBy === 'date'
    ? new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime()
    : (second.evaluation?.score || 0) - (first.evaluation?.score || 0));
  const deleteOutfit = (outfit: SavedOutfit) => {
    if (deleteTimeout.current) clearTimeout(deleteTimeout.current);
    if (pendingDeletion.current) void onDeletePermanent(pendingDeletion.current);
    setSelectedOutfit(null);
    onDelete(outfit.id);
    pendingDeletion.current = outfit;
    setRecentlyDeleted(outfit);
    deleteTimeout.current = setTimeout(() => {
      const pending = pendingDeletion.current;
      if (pending?.id === outfit.id) {
        void onDeletePermanent(pending);
        pendingDeletion.current = null;
        setRecentlyDeleted(null);
      }
    }, 4000);
  };
  const undoDelete = () => {
    if (deleteTimeout.current) clearTimeout(deleteTimeout.current);
    if (recentlyDeleted) onRestore(recentlyDeleted);
    pendingDeletion.current = null;
    setRecentlyDeleted(null);
  };
  return <>
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}><View style={{ height: 18 }} /><View style={styles.wardrobeHeader}><Text style={styles.eyebrow}>HISTORIAL</Text><Text style={styles.title}>Tus outfits</Text><Text style={styles.addIntro}>{outfits.length} outfits analizados.</Text></View><View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}><TouchableOpacity onPress={() => setSortBy('date')} style={[styles.categoryFilter, sortBy === 'date' && styles.categoryFilterActive]}><Feather name="calendar" size={14} color={sortBy === 'date' ? COLORS.white : COLORS.sageDark} /><Text style={[styles.categoryFilterText, sortBy === 'date' && styles.categoryFilterTextActive]}>Más recientes</Text></TouchableOpacity>{showOutfitScore && <TouchableOpacity onPress={() => setSortBy('score')} style={[styles.categoryFilter, sortBy === 'score' && styles.categoryFilterActive]}><Feather name="star" size={14} color={sortBy === 'score' ? COLORS.white : COLORS.sageDark} /><Text style={[styles.categoryFilterText, sortBy === 'score' && styles.categoryFilterTextActive]}>Mejor puntuación</Text></TouchableOpacity>}</View>{orderedOutfits.map((outfit) => <OutfitHistoryCard key={outfit.id} outfit={outfit} onOpen={() => setSelectedOutfit(outfit)} onDelete={() => deleteOutfit(outfit)} showOutfitScore={showOutfitScore} />)}</ScrollView>
    <Modal visible={selectedOutfit !== null} transparent animationType="slide" onRequestClose={() => setSelectedOutfit(null)}><View style={styles.detailBackdrop}><TouchableOpacity style={styles.filterModalDismiss} activeOpacity={1} onPress={() => setSelectedOutfit(null)} />{selectedOutfit && <View style={styles.editGarmentSheet}><View style={styles.filterModalHead}><View><Text style={styles.eyebrow}>DETALLE DEL OUTFIT</Text><Text style={styles.filterModalTitle}>{new Date(selectedOutfit.createdAt).toLocaleDateString('es-ES')}</Text></View><TouchableOpacity style={styles.filterClose} onPress={() => setSelectedOutfit(null)}><Feather name="x" size={20} color={COLORS.ink} /></TouchableOpacity></View><ScrollView showsVerticalScrollIndicator={false}><TouchableOpacity activeOpacity={0.9} onPress={() => setFullScreenImage(selectedOutfit.imageUri)}><Image source={{ uri: selectedOutfit.imageUri }} style={{ width: '100%', height: 220, borderRadius: 18, marginBottom: 15 }} /></TouchableOpacity>{selectedOutfit.evaluation && <View style={styles.outfitEvaluation}><Text style={styles.evaluationTitle}>{showOutfitScore ? `Valoración · ${Math.round(selectedOutfit.evaluation.score)}/100` : 'Valoración del outfit'}</Text><Text style={styles.evaluationSummary}>{selectedOutfit.evaluation.summary}</Text>{[...selectedOutfit.evaluation.strengths, ...(showImprovementPoints ? [...selectedOutfit.evaluation.improvements, ...selectedOutfit.evaluation.suggestions] : [])].map((text, index) => <Text key={index} style={styles.evaluationRowText}>• {text}</Text>)}</View>}<Text style={styles.evaluationTitle}>Prendas identificadas</Text>{selectedOutfit.garments.map((item, index) => <View key={index} style={{ backgroundColor: COLORS.white, borderRadius: 14, padding: 12, marginTop: 9 }}><Text style={styles.cardTitle}>{garmentTitle(item)}</Text><Text style={styles.cardMeta}>{item.category} · {item.subcategory}</Text><Text style={styles.cardMeta}>{item.primaryColor} · {item.brand || 'Marca no identificada'}</Text><Text style={styles.cardMeta}>{item.pattern} · {item.fabricType} · {item.texture}</Text>{hasUsefulValue(item.materialEstimate) && <Text style={styles.cardMeta}>Composición aparente: {item.materialEstimate}</Text>}<Text style={styles.cardMeta}>{item.styles.join(', ')} · Confianza {Math.round(item.confidence * 100)}%</Text></View>)}</ScrollView></View>}</View></Modal>
    <Modal visible={fullScreenImage !== null} transparent animationType="fade" onRequestClose={() => setFullScreenImage(null)}><View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}><TouchableOpacity onPress={() => setFullScreenImage(null)} style={{ position: 'absolute', top: 52, right: 20, zIndex: 2, width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }}><Feather name="x" size={22} color={COLORS.ink} /></TouchableOpacity>{fullScreenImage && <Image source={{ uri: fullScreenImage }} resizeMode="contain" style={{ width: '100%', height: '100%' }} />}</View></Modal>
    {recentlyDeleted && <View style={{ position: 'absolute', left: 20, right: 20, bottom: 22, minHeight: 54, borderRadius: 16, backgroundColor: COLORS.ink, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, elevation: 6 }}><Text style={{ color: COLORS.white, fontSize: 12, fontWeight: '700' }}>Outfit eliminado</Text><TouchableOpacity onPress={undoDelete} style={{ paddingVertical: 10, paddingLeft: 16 }}><Text style={{ color: '#DDE7D6', fontSize: 12, fontWeight: '800' }}>Deshacer</Text></TouchableOpacity></View>}
  </>;
}

function HomeCategoryCard({ category, imageIndex, onPress }: { category: HomeCategory; imageIndex: number; onPress: () => void }) {
  const [displayedIndex, setDisplayedIndex] = useState(imageIndex);
  const opacity = useState(() => new Animated.Value(1))[0];

  useEffect(() => {
    let active = true;
    if (imageIndex !== displayedIndex) {
      Animated.timing(opacity, { toValue: 0.78, duration: 350, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start(() => {
        if (!active) return;
        setDisplayedIndex(imageIndex);
        Animated.timing(opacity, { toValue: 1, duration: 850, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start();
      });
    }
    return () => {
      active = false;
      opacity.stopAnimation();
      opacity.setValue(1);
    };
  }, [imageIndex, opacity]);

  return <TouchableOpacity style={styles.categoryCard} activeOpacity={0.84} onPress={onPress}>
    <View style={styles.categoryImageFrame}><Animated.Image source={{ uri: category.imageUris[displayedIndex] }} style={[styles.categoryImage, { opacity }]} />{category.imageUris.length > 1 && <View style={styles.carouselCount}><Feather name="layers" size={9} color={COLORS.white} /><Text style={styles.carouselCountText}>{category.imageUris.length}</Text></View>}</View>
    <Text style={styles.cardTitle}>{category.label}</Text><Text style={styles.cardMeta}>{category.count} {category.count === 1 ? 'prenda' : 'prendas'}</Text>
  </TouchableOpacity>;
}

function Home({ items, onAdd, onCamera, onOpenWardrobe, onOpenProfile }: { items: SavedGarment[]; onAdd: () => void; onCamera: () => void; onOpenWardrobe: (categoryKey?: string) => void; onOpenProfile: () => void }) {
  const todayLabel = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toLocaleUpperCase('es');
  const hour = new Date().getHours();
  const greeting = `${hour < 14 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches'}, Kevin M.B.`;
  const homeCategories = Object.values(items.reduce<Record<string, HomeCategory>>((groups, item) => {
    const category = normalizedCategory(item.category);
    groups[category.key] = {
      key: category.key,
      label: category.label,
      count: (groups[category.key]?.count || 0) + 1,
      imageUris: [...(groups[category.key]?.imageUris || []), item.imageUri],
    };
    return groups;
  }, {})).sort((first, second) => second.count - first.count);
  const [categoryImageIndexes, setCategoryImageIndexes] = useState<Record<string, number>>({});
  const carouselSignature = homeCategories.map((category) => `${category.key}:${category.imageUris.length}`).join('|');

  useEffect(() => {
    const carouselCategories = homeCategories.filter((category) => category.imageUris.length > 1);
    if (carouselCategories.length === 0) return undefined;
    let active = true;
    let lastCategoryKey = '';
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = 5200 + Math.random() * 6600;
      timer = setTimeout(() => {
        if (!active) return;
        const alternatives = carouselCategories.filter((category) => category.key !== lastCategoryKey);
        const choices = alternatives.length > 0 ? alternatives : carouselCategories;
        const selected = choices[Math.floor(Math.random() * choices.length)];
        lastCategoryKey = selected.key;
        setCategoryImageIndexes((current) => ({ ...current, [selected.key]: ((current[selected.key] || 0) + 1) % selected.imageUris.length }));
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [carouselSignature]);

  return <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
    <View style={styles.header}>
      <View style={{ flex: 1, paddingRight: 12 }}><Text numberOfLines={1} style={styles.eyebrow}>{todayLabel}</Text><Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>{greeting}</Text></View>
      <TouchableOpacity style={styles.avatar} onPress={onOpenProfile}><Text style={styles.avatarText}>K</Text></TouchableOpacity>
    </View>

    <TouchableOpacity style={styles.captureCard} onPress={onCamera} activeOpacity={0.88}>
      <View style={styles.captureCopy}><Text style={styles.captureKicker}>NUEVO OUTFIT</Text><Text style={styles.captureTitle}>Haz una foto</Text><Text style={styles.captureText}>Abre la cámara y analizaremos tu conjunto al momento.</Text></View>
      <View style={styles.cameraButton}><Feather name="camera" size={24} color={COLORS.white} /></View>
    </TouchableOpacity>

    <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Tu armario</Text>{items.length > 0 && <TouchableOpacity onPress={() => onOpenWardrobe()}><Text style={styles.link}>Ver todo</Text></TouchableOpacity>}</View>
    {items.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
      {homeCategories.map((category) => <HomeCategoryCard key={category.key} category={category} imageIndex={(categoryImageIndexes[category.key] || 0) % category.imageUris.length} onPress={() => onOpenWardrobe(category.key)} />)}
    </ScrollView> : <TouchableOpacity style={styles.homeWardrobeEmpty} onPress={onAdd} activeOpacity={0.84}><View style={styles.homeWardrobeEmptyIcon}><Feather name="grid" size={22} color={COLORS.sageDark} /></View><View style={styles.homeWardrobeEmptyCopy}><Text style={styles.homeWardrobeEmptyTitle}>Tu armario está vacío</Text><Text style={styles.homeWardrobeEmptyText}>Escanea tu primer outfit para empezar a organizarlo.</Text></View><Feather name="arrow-right" size={19} color={COLORS.sageDark} /></TouchableOpacity>}

    <View style={styles.sectionHead}><Text style={styles.sectionTitle}>Una compra que encaja</Text><Text style={styles.link}>Explorar</Text></View>
    <View style={styles.recommendation}>
      <View style={styles.productVisual}><Text style={styles.productEmoji}>🧶</Text><View style={styles.matchBadge}><Feather name="zap" size={11} color={COLORS.sageDark}/><Text style={styles.matchText}>8 conjuntos</Text></View></View>
      <View style={styles.productInfo}><Text style={styles.shop}>COMERCIO SELECCIONADO</Text><Text style={styles.productName}>Jersey de punto crudo</Text><Text style={styles.productReason}>Completa tus básicos y combina con 8 prendas.</Text><View style={styles.priceRow}><Text style={styles.price}>39,95 €</Text><Feather name="arrow-up-right" size={19} color={COLORS.ink}/></View></View>
    </View>
    <Text style={styles.disclosure}>Sugerencia basada en tu armario · El precio puede cambiar</Text>
  </ScrollView>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('inicio');
  const [captureFromCamera, setCaptureFromCamera] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [wardrobeLoading, setWardrobeLoading] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [savedGarments, setSavedGarments] = useState<SavedGarment[]>([]);
  const [savedOutfits, setSavedOutfits] = useState<SavedOutfit[]>([]);
  const [wardrobeInitialCategory, setWardrobeInitialCategory] = useState('todas');
  useEffect(() => {
    const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    console.log('[Supabase] Inicializando conexión…', {
      url: configuredUrl || '(no configurada)',
      anonKeyConfigured: Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
    });

    let mounted = true;
    void supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          setAuthLoading(false);
          console.warn('[Supabase] Error recuperando la sesión:', {
            name: error.name,
            message: error.message,
            status: error.status,
          });
          return;
        }
        if (!data.session) {
          setSession(null);
          setOnboardingCompleted(false);
          setAuthLoading(false);
          console.log('[Supabase] Conexión correcta. Sesión: sin sesión');
          return;
        }
        console.log('[Supabase] Sesión local encontrada. Validando usuario en servidor…');
        void supabase.auth.getUser(data.session.access_token)
          .then(async ({ data: userData, error: userError }) => {
            if (!mounted) return;
            if (userError || !userData.user) {
              console.warn('[Supabase] La cuenta local ya no es válida. Limpiando sesión:', userError?.message || 'usuario no encontrado');
              await supabase.auth.signOut({ scope: 'local' });
              if (!mounted) return;
              setSession(null);
              setOnboardingCompleted(false);
              setAuthLoading(false);
              return;
            }
            setSession(data.session);
            setOnboardingCompleted(userData.user.user_metadata?.onboarding_completed === true);
            setAuthLoading(false);
            console.log('[Supabase] Conexión y sesión válidas. Usuario:', userData.user.id);
          })
          .catch(async (validationError) => {
            if (!mounted) return;
            console.error('[Supabase] Fallo validando la sesión local:', validationError?.message || validationError);
            await supabase.auth.signOut({ scope: 'local' });
            if (!mounted) return;
            setSession(null);
            setOnboardingCompleted(false);
            setAuthLoading(false);
          });
      })
      .catch((error) => {
        if (!mounted) return;
        setAuthLoading(false);
        console.error('[Supabase] Fallo de red al recuperar la sesión:', error?.message || error);
      });

    const { data: authSubscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return;
      setSession(session);
      setOnboardingCompleted(session?.user.user_metadata?.onboarding_completed === true);
      setAuthLoading(false);
      console.log('[Supabase] Cambio de autenticación:', event, session ? 'sesión activa' : 'sin sesión');
    });

    return () => {
      mounted = false;
      authSubscription.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!session?.user.id) {
      setSavedGarments([]);
      setSavedOutfits([]);
      return;
    }
    let active = true;
    setWardrobeLoading(true);
    void (async () => {
      const [{ data: garmentRows, error: garmentError }, { data: outfitRows, error: outfitError }, { data: outfitGarmentRows, error: outfitGarmentError }] = await Promise.all([
        supabase.from('garments').select('*').order('created_at', { ascending: false }),
        supabase.from('outfits').select('*').order('taken_at', { ascending: false }),
        supabase.from('outfit_garments').select('outfit_id, garment_id, item_box, display_rotation, confidence'),
      ]);
      if (garmentError || outfitError || outfitGarmentError) {
        const error = garmentError || outfitError || outfitGarmentError;
        console.error('[Supabase] Error cargando el armario:', error);
        if (active) setNotice({ title: 'No hemos podido cargar tu armario', message: error?.message || 'Error desconocido' });
        return;
      }
      const garments = await Promise.all((garmentRows as DatabaseGarmentRow[]).map(async (row) => {
        try {
          return rowToSavedGarment(row, await signedGarmentUrl(row.image_path));
        } catch (error) {
          console.warn('[Supabase] No se pudo firmar una foto del armario:', error);
          return null;
        }
      }));
      const hydratedGarments = garments.filter((item): item is SavedGarment => item !== null);
      const garmentsById = new Map(hydratedGarments.map((item) => [item.id, item]));
      const linksByOutfit = new Map<string, string[]>();
      for (const link of outfitGarmentRows || []) {
        const current = linksByOutfit.get(link.outfit_id) || [];
        current.push(link.garment_id);
        linksByOutfit.set(link.outfit_id, current);
      }
      const outfits: Array<SavedOutfit | null> = await Promise.all((outfitRows as DatabaseOutfitRow[]).map(async (row): Promise<SavedOutfit | null> => {
        try {
          return {
            id: row.id,
            imageUri: await signedOutfitUrl(row.image_path),
            storagePath: row.image_path,
            garments: (linksByOutfit.get(row.id) || []).map((id) => garmentsById.get(id)).filter((item): item is SavedGarment => Boolean(item)),
            evaluation: row.evaluation as OutfitEvaluation | null,
            createdAt: row.taken_at || row.created_at,
          };
        } catch (error) {
          console.warn('[Supabase] No se pudo firmar una foto de outfit:', error);
          return null;
        }
      }));
      if (active) {
        setSavedGarments(hydratedGarments);
        setSavedOutfits(outfits.filter((item): item is SavedOutfit => item !== null));
      }
    })().catch((error) => {
      console.error('[Supabase] Error inesperado cargando el armario:', error);
    }).finally(() => {
      if (active) setWardrobeLoading(false);
    });
    return () => { active = false; };
  }, [session?.user.id]);

  const persistGarment = async (item: SavedGarment) => {
    if (!session?.user.id) throw new Error('Tu sesión ha caducado. Vuelve a iniciar sesión.');
    const storagePath = await uploadGarmentImage(session.user.id, item.imageUri);
    const { data, error } = await supabase.from('garments').insert({ user_id: session.user.id, ...garmentPayload(item, storagePath) }).select().single();
    if (error || !data) {
      await supabase.storage.from(GARMENT_BUCKET).remove([storagePath]);
      throw new Error(error?.message || 'No hemos podido guardar la prenda.');
    }
    return rowToSavedGarment(data as DatabaseGarmentRow, await signedGarmentUrl(storagePath));
  };

  const saveToWardrobe = async (items: SavedGarment[], wornItemIds: string[], updatedItems: SavedGarment[], outfit: OutfitDraft, appearanceItems: SavedGarment[], matchedGarmentIds: Record<string, string>) => {
    let outfitStoragePath: string | null = null;
    let persistedOutfitId: string | null = null;
    try {
      if (!session?.user.id) throw new Error('Tu sesión ha caducado. Vuelve a iniciar sesión.');
      const persistedItems = await Promise.all(items.map(persistGarment));
      const updatesById = new Map(updatedItems.map((item) => [item.id, item]));
      const nextExistingItems = await Promise.all(savedGarments.map(async (item) => {
        const updated = updatesById.get(item.id) || item;
        const wearCount = (updated.wearCount || item.wearCount || 1) + (wornItemIds.includes(item.id) ? 1 : 0);
        if (!updatesById.has(item.id) && !wornItemIds.includes(item.id)) return item;
        let storagePath = updated.storagePath || item.storagePath;
        if (isLocalImage(updated.imageUri)) storagePath = await uploadGarmentImage(session!.user.id, updated.imageUri, storagePath);
        const { data, error } = await supabase.from('garments').update(garmentPayload({ ...updated, wearCount }, storagePath || '')).eq('id', item.id).select().single();
        if (error || !data) throw new Error(error?.message || 'No hemos podido actualizar una prenda.');
        return rowToSavedGarment(data as DatabaseGarmentRow, storagePath ? await signedGarmentUrl(storagePath) : item.imageUri);
      }));
      const nextGarments = [...persistedItems, ...nextExistingItems];
      const persistedByTemporaryId = new Map(items.map((item, index) => [item.id, persistedItems[index]]));
      const linkedGarmentIds = new Map<string, { garmentId: string; item: SavedGarment }>();
      for (const item of appearanceItems) {
        const garmentId = matchedGarmentIds[item.id] || persistedByTemporaryId.get(item.id)?.id;
        if (garmentId && !linkedGarmentIds.has(garmentId)) linkedGarmentIds.set(garmentId, { garmentId, item });
      }
      if (linkedGarmentIds.size === 0) throw new Error('No hemos podido asociar las prendas al outfit.');

      outfitStoragePath = await uploadOutfitImage(session.user.id, outfit.imageUri);
      const uploadedOutfitPath = outfitStoragePath;
      const { data: outfitRow, error: outfitError } = await supabase.from('outfits').insert({
        user_id: session.user.id,
        image_path: uploadedOutfitPath,
        evaluation: outfit.evaluation,
        taken_at: outfit.createdAt,
      }).select().single();
      if (outfitError || !outfitRow) throw new Error(outfitError?.message || 'No hemos podido guardar el outfit.');
      persistedOutfitId = outfitRow.id;
      const savedOutfitId = outfitRow.id;

      const outfitLinks = [...linkedGarmentIds.values()].map(({ garmentId, item }) => ({
        outfit_id: savedOutfitId,
        garment_id: garmentId,
        item_box: item.itemBox,
        display_rotation: item.displayRotation || 0,
        confidence: item.confidence || 0,
      }));
      const { error: linksError } = await supabase.from('outfit_garments').insert(outfitLinks);
      if (linksError) throw new Error(`No hemos podido guardar las prendas del outfit: ${linksError.message}`);

      const { error: usageError } = await supabase.from('garment_usage_events').insert(
        outfitLinks.map((link) => ({ user_id: session.user.id, garment_id: link.garment_id, outfit_id: savedOutfitId, used_at: outfit.createdAt })),
      );
      if (usageError) console.warn('[Supabase] El outfit se guardó, pero no el registro de uso:', usageError.message);

      const createdOutfit: SavedOutfit = {
        id: savedOutfitId,
        imageUri: await signedOutfitUrl(uploadedOutfitPath),
        storagePath: uploadedOutfitPath,
        garments: outfitLinks.map((link) => nextGarments.find((item) => item.id === link.garment_id)).filter((item): item is SavedGarment => Boolean(item)),
        evaluation: outfit.evaluation,
        createdAt: (outfitRow as DatabaseOutfitRow).taken_at,
      };
      setSavedGarments(nextGarments);
      setSavedOutfits((current) => [createdOutfit, ...current]);
      setWardrobeInitialCategory('todas');
      setTab('armario');
      if (items.length === 0 && wornItemIds.length > 0) {
        setNotice({ title: 'Usos actualizados', message: wornItemIds.length === 1 ? 'La prenda ya estaba en tu armario. Hemos actualizado su ficha y sumado un uso.' : `Las ${wornItemIds.length} prendas ya estaban en tu armario. Hemos actualizado sus fichas y sumado sus usos.` });
        return;
      }
      const messages = [];
      if (items.length > 0) messages.push(`Hemos añadido ${items.length} ${items.length === 1 ? 'prenda' : 'prendas'} a tu armario.`);
      if (wornItemIds.length > 0) messages.push(`Hemos registrado ${wornItemIds.length} ${wornItemIds.length === 1 ? 'nuevo uso' : 'nuevos usos'}.`);
      setNotice({ title: 'Armario guardado', message: messages.join('\n') });
    } catch (error) {
      if (persistedOutfitId) await supabase.from('outfits').delete().eq('id', persistedOutfitId);
      if (outfitStoragePath) await supabase.storage.from(OUTFIT_BUCKET).remove([outfitStoragePath]);
      console.error('[Supabase] Error guardando el armario:', error);
      setNotice({ title: 'No hemos podido guardar el armario', message: error instanceof Error ? error.message : 'Comprueba tu conexión e inténtalo de nuevo.' });
      throw error;
    }
  };
  const deleteFromWardrobe = async (id: string) => {
    const item = savedGarments.find((garment) => garment.id === id);
    try {
      const { error } = await supabase.from('garments').delete().eq('id', id);
      if (error) throw error;
      if (item?.storagePath) {
        const { error: storageError } = await supabase.storage.from(GARMENT_BUCKET).remove([item.storagePath]);
        if (storageError) console.warn('[Supabase] La ficha se eliminó, pero no la imagen:', storageError.message);
      }
      setSavedGarments((current) => current.filter((garment) => garment.id !== id));
      setNotice({ title: 'Prenda eliminada', message: 'La prenda y su foto se han eliminado del armario.' });
    } catch (error) {
      setNotice({ title: 'No hemos podido eliminar la prenda', message: error instanceof Error ? error.message : 'Vuelve a intentarlo.' });
    }
  };
  const mergeWardrobeItems = async (keptId: string, mergedId: string) => {
    const keptItem = savedGarments.find((item) => item.id === keptId);
    const mergedItem = savedGarments.find((item) => item.id === mergedId);
    if (!keptItem || !mergedItem) return;
    try {
      const mergedWearCount = (keptItem.wearCount || 1) + (mergedItem.wearCount || 1);
      const { data, error } = await supabase.from('garments').update(garmentPayload({ ...keptItem, wearCount: mergedWearCount }, keptItem.storagePath || '')).eq('id', keptId).select().single();
      if (error || !data) throw new Error(error?.message || 'No hemos podido fusionar las prendas.');
      const { error: deleteError } = await supabase.from('garments').delete().eq('id', mergedId);
      if (deleteError) throw deleteError;
      if (mergedItem.storagePath) await supabase.storage.from(GARMENT_BUCKET).remove([mergedItem.storagePath]);
      const persistedKept = rowToSavedGarment(data as DatabaseGarmentRow, keptItem.storagePath ? await signedGarmentUrl(keptItem.storagePath) : keptItem.imageUri);
      setSavedGarments((current) => current.filter((item) => item.id !== mergedId).map((item) => item.id === keptId ? persistedKept : item));
      setNotice({ title: 'Prendas fusionadas', message: 'Hemos combinado sus usos y eliminado la foto duplicada.' });
    } catch (error) {
      setNotice({ title: 'No hemos podido fusionar las prendas', message: error instanceof Error ? error.message : 'Vuelve a intentarlo.' });
    }
  };
  const updateWardrobeItem = async (updatedItem: SavedGarment) => {
    try {
      let storagePath = updatedItem.storagePath;
      if (isLocalImage(updatedItem.imageUri)) {
        if (!session?.user.id) throw new Error('Tu sesión ha caducado.');
        storagePath = await uploadGarmentImage(session.user.id, updatedItem.imageUri, storagePath);
      }
      if (!storagePath) throw new Error('No se ha encontrado la foto de esta prenda.');
      const { data, error } = await supabase.from('garments').update(garmentPayload(updatedItem, storagePath)).eq('id', updatedItem.id).select().single();
      if (error || !data) throw new Error(error?.message || 'No hemos podido guardar los cambios.');
      const persistedItem = rowToSavedGarment(data as DatabaseGarmentRow, await signedGarmentUrl(storagePath));
      setSavedGarments((current) => current.map((item) => item.id === persistedItem.id ? persistedItem : item));
      setNotice({ title: 'Cambios guardados', message: 'La ficha de la prenda se ha actualizado.' });
    } catch (error) {
      setNotice({ title: 'No hemos podido guardar los cambios', message: error instanceof Error ? error.message : 'Vuelve a intentarlo.' });
    }
  };
  const deleteOutfit = (id: string) => setSavedOutfits((current) => current.filter((outfit) => outfit.id !== id));
  const restoreOutfit = (outfit: SavedOutfit) => setSavedOutfits((current) => current.some((item) => item.id === outfit.id) ? current : [outfit, ...current]);
  const deleteOutfitPermanently = async (outfit: SavedOutfit) => {
    try {
      const { error } = await supabase.from('outfits').delete().eq('id', outfit.id);
      if (error) throw error;
      if (outfit.storagePath) {
        const { error: storageError } = await supabase.storage.from(OUTFIT_BUCKET).remove([outfit.storagePath]);
        if (storageError) console.warn('[Supabase] El outfit se eliminó, pero no su foto:', storageError.message);
      }
    } catch (error) {
      console.error('[Supabase] No se pudo eliminar el outfit:', error);
      setSavedOutfits((current) => current.some((item) => item.id === outfit.id) ? current : [outfit, ...current]);
      setNotice({ title: 'No hemos podido eliminar el outfit', message: error instanceof Error ? error.message : 'Vuelve a intentarlo.' });
    }
  };
  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) setNotice({ title: 'No hemos podido cerrar sesión', message: error.message });
  };
  const reopenOnboarding = () => {
    setTab('inicio');
    setOnboardingCompleted(false);
  };
  if (authLoading || (session && wardrobeLoading)) return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" backgroundColor={COLORS.paper} translucent={false} /><View style={styles.authLoading}><ActivityIndicator color={COLORS.sageDark} /><Text style={styles.authLoadingText}>Conectando con tu armario…</Text></View></SafeAreaView>;
  if (!session) return <LoginScreen />;
  if (!onboardingCompleted) return <OnboardingScreen initialName={session.user.user_metadata?.display_name || session.user.user_metadata?.full_name || session.user.user_metadata?.name || ''} initialGender={session.user.user_metadata?.gender_identity} initialStyles={session.user.user_metadata?.style_preferences} initialColors={session.user.user_metadata?.color_preferences} initialShops={session.user.user_metadata?.favorite_shops} initialShowOutfitScore={session.user.user_metadata?.show_outfit_score !== false} initialShowImprovementPoints={session.user.user_metadata?.show_improvement_points !== false} onComplete={() => setOnboardingCompleted(true)} />;
  return <NoticeContext.Provider value={{ showNotice: setNotice }}><SafeAreaView style={styles.safe}>
    <StatusBar barStyle="dark-content" backgroundColor={COLORS.paper} />
    <View style={styles.app}>{tab === 'inicio' ? <Home items={savedGarments} onAdd={() => { setCaptureFromCamera(false); setTab('captura'); }} onCamera={() => { setCaptureFromCamera(true); setTab('captura'); }} onOpenWardrobe={(categoryKey = 'todas') => { setWardrobeInitialCategory(categoryKey); setTab('armario'); }} onOpenProfile={() => setTab('perfil')} /> : tab === 'captura' ? <AddOutfit startWithCamera={captureFromCamera} onSave={saveToWardrobe} wardrobeItems={savedGarments} showOutfitScore={session.user.user_metadata?.show_outfit_score !== false} showImprovementPoints={session.user.user_metadata?.show_improvement_points !== false} /> : tab === 'armario' ? <Wardrobe items={savedGarments} initialCategory={wardrobeInitialCategory} onDelete={deleteFromWardrobe} onMerge={mergeWardrobeItems} onUpdate={updateWardrobeItem} /> : tab === 'outfits' ? <Outfits outfits={savedOutfits} onDelete={deleteOutfit} onRestore={restoreOutfit} onDeletePermanent={deleteOutfitPermanently} showOutfitScore={session.user.user_metadata?.show_outfit_score !== false} showImprovementPoints={session.user.user_metadata?.show_improvement_points !== false} /> : tab === 'perfil' ? <Profile onBack={() => setTab('inicio')} email={session.user.email} displayName={session.user.user_metadata?.display_name} onSignOut={() => void signOut()} onEditSetup={reopenOnboarding} /> : <EmptyScreen tab={tab} />}</View>
    {tab !== 'perfil' && <View style={styles.nav}>
      {nav.map((item) => {
        const active = tab === item.key;
        const add = item.key === 'captura';
        return <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => { if (item.key === 'armario') setWardrobeInitialCategory('todas'); if (item.key === 'captura') setCaptureFromCamera(false); setTab(item.key); }} accessibilityLabel={item.label}>
          <View style={add ? styles.addNav : undefined}><Feather name={item.icon} size={add ? 25 : 21} color={add ? COLORS.white : active ? COLORS.sageDark : '#96908A'} /></View>
          {!add && <Text style={[styles.navLabel, active && styles.navLabelActive]}>{item.label}</Text>}
        </TouchableOpacity>;
      })}
    </View>}
    <AppNotice notice={notice} onDismiss={() => setNotice(null)} />
  </SafeAreaView></NoticeContext.Provider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.paper, paddingTop: Platform.OS === 'android' ? 14 : 0 }, app: { flex: 1 }, scroll: { padding: 20, paddingBottom: 34 },
  authLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }, authLoadingText: { color: COLORS.muted, fontSize: 13, fontWeight: '600' },
  loginScroll: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingVertical: 36 }, loginHero: { alignItems: 'center', marginBottom: 24 }, loginIcon: { width: 68, height: 68, borderRadius: 22, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }, loginEyebrow: { color: COLORS.sageDark, fontSize: 10, letterSpacing: 1.7, fontWeight: '800', marginBottom: 9 }, loginTitle: { color: COLORS.ink, fontSize: 29, lineHeight: 35, fontWeight: '800', letterSpacing: -0.8, textAlign: 'center' }, loginSubtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 12, maxWidth: 315 }, loginCard: { backgroundColor: COLORS.white, borderRadius: 26, padding: 20, borderWidth: 1, borderColor: COLORS.line, shadowColor: COLORS.ink, shadowOpacity: 0.055, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 2 }, loginCardEyebrow: { color: COLORS.sageDark, fontSize: 9, letterSpacing: 1.45, fontWeight: '900', marginBottom: 7 }, loginCardTitle: { color: COLORS.ink, fontSize: 21, lineHeight: 26, fontWeight: '800', letterSpacing: -0.45 }, loginCardDescription: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginTop: 5, marginBottom: 18 }, loginFieldGroup: { marginBottom: 12 }, loginPasswordLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }, loginFieldLabel: { color: COLORS.ink, fontSize: 11, fontWeight: '800', marginBottom: 7 }, loginForgot: { color: COLORS.sageDark, fontSize: 10, fontWeight: '800' }, loginInputWrap: { height: 52, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }, loginInputWrapFocused: { borderColor: COLORS.sageDark, backgroundColor: '#F7FAF4', shadowColor: COLORS.sageDark, shadowOpacity: 0.12, shadowRadius: 7, shadowOffset: { width: 0, height: 2 }, elevation: 1 }, loginInput: { flex: 1, height: '100%', color: COLORS.ink, fontSize: 14 }, loginStandaloneInput: { height: 50, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', paddingHorizontal: 14, color: COLORS.ink, fontSize: 14, marginBottom: 10 }, loginPrimary: { height: 53, borderRadius: 16, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center', marginTop: 5, shadowColor: COLORS.sageDark, shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, loginPrimaryText: { color: COLORS.white, fontSize: 14, fontWeight: '800' }, loginSwitch: { alignSelf: 'center', flexDirection: 'row', paddingVertical: 16 }, loginSwitchPrompt: { color: COLORS.muted, fontSize: 12, fontWeight: '600' }, loginSwitchText: { color: COLORS.sageDark, fontSize: 12, fontWeight: '800' }, loginDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 15 }, loginDividerLine: { flex: 1, height: 1, backgroundColor: COLORS.line }, loginDividerText: { color: COLORS.muted, fontSize: 10, fontWeight: '700' }, loginSocial: { height: 52, borderRadius: 15, borderWidth: 1, borderColor: '#D6D1CA', backgroundColor: COLORS.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 10, position: 'relative' }, loginSocialText: { color: COLORS.ink, fontSize: 13, fontWeight: '800' }, loginGoogleMark: { position: 'absolute', left: 17, color: '#4285F4', fontSize: 18, fontWeight: '900' }, loginApple: { backgroundColor: COLORS.ink, borderColor: COLORS.ink }, loginAppleMark: { position: 'absolute', left: 18, color: COLORS.white, fontSize: 18 }, loginAppleText: { color: COLORS.white, fontSize: 13, fontWeight: '800' }, loginMessage: { color: '#A54E43', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 6 }, signOutButton: { alignSelf: 'flex-start', marginTop: 18, minHeight: 46, borderRadius: 14, borderWidth: 1, borderColor: '#DFC4BF', backgroundColor: '#FCF4F2', paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 8 }, signOutButtonText: { color: '#A54E43', fontSize: 12, fontWeight: '800' },
  loginLookbook: { width: 170, height: 116, borderRadius: 29, backgroundColor: '#E7DED3', marginBottom: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, loginLookbookCircle: { position: 'absolute', width: 123, height: 123, borderRadius: 62, backgroundColor: '#C8D1BD', top: -55, right: -19 }, loginLookbookSquare: { position: 'absolute', width: 86, height: 86, borderRadius: 24, backgroundColor: '#D98567', bottom: -43, left: -22, transform: [{ rotate: '24deg' }] }, loginLookbookLabel: { position: 'absolute', right: 10, bottom: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.82)', paddingHorizontal: 8, paddingVertical: 5 }, loginLookbookLabelText: { color: COLORS.ink, fontSize: 7, fontWeight: '900', letterSpacing: 1 }, loginBenefits: { flexDirection: 'row', alignItems: 'center', marginTop: 16 }, loginBenefit: { flexDirection: 'row', alignItems: 'center', gap: 6 }, loginBenefitText: { color: COLORS.sageDark, fontSize: 10, fontWeight: '800' }, loginBenefitDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: '#AAA39C', marginHorizontal: 10 }, loginLegal: { color: '#9B958E', fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 15, paddingHorizontal: 20 },
  loginWordmark: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', marginBottom: 20 }, loginWordmarkDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.clay, marginRight: 7 }, loginWordmarkText: { color: COLORS.ink, fontSize: 12, letterSpacing: 2.6, fontWeight: '900' }, loginWordmarkSub: { color: COLORS.muted, fontSize: 8, letterSpacing: 1.4, fontWeight: '800', marginLeft: 8 }, loginWelcome: { alignSelf: 'stretch', minHeight: 138, borderRadius: 24, overflow: 'hidden', backgroundColor: '#E9E3D8', padding: 20, flexDirection: 'row' }, loginWelcomeCopy: { flex: 1, zIndex: 2, paddingRight: 12 }, loginWelcomeKicker: { color: COLORS.sageDark, fontSize: 8, fontWeight: '900', letterSpacing: 1.25, marginBottom: 10 }, loginWelcomeTitle: { color: COLORS.ink, fontSize: 24, lineHeight: 27, letterSpacing: -0.75, fontWeight: '800' }, loginWelcomeText: { color: '#625D57', fontSize: 10, lineHeight: 15, marginTop: 8, maxWidth: 185 }, loginWelcomeArtwork: { width: 112, position: 'absolute', right: 0, top: 0, bottom: 0, overflow: 'hidden' }, loginWelcomeArch: { position: 'absolute', width: 142, height: 142, borderRadius: 71, backgroundColor: COLORS.sage, top: 32, right: -32 }, loginWelcomeTile: { position: 'absolute', width: 76, height: 126, borderTopLeftRadius: 38, backgroundColor: COLORS.clay, top: -28, right: 3, transform: [{ rotate: '18deg' }] }, loginWelcomeIcon: { position: 'absolute', width: 46, height: 46, borderRadius: 23, backgroundColor: '#FFFCF7', right: 24, bottom: 20, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 }, loginGoogleIcon: { position: 'absolute', left: 16 }, loginAppleIcon: { position: 'absolute', left: 16 },
  onboardingScroll: { flexGrow: 1, padding: 20, paddingBottom: 116 }, onboardingTop: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, onboardingBack: { minWidth: 60, minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 5 }, onboardingBackText: { color: COLORS.ink, fontSize: 11, fontWeight: '700' }, onboardingCounter: { color: COLORS.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 }, onboardingProgress: { height: 4, borderRadius: 2, backgroundColor: COLORS.line, overflow: 'hidden', marginTop: 10 }, onboardingProgressFill: { height: '100%', borderRadius: 2, backgroundColor: COLORS.clay }, onboardingHero: { alignItems: 'center', paddingTop: 25, marginBottom: 21 }, onboardingStepIcon: { width: 50, height: 50, borderRadius: 18, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center', marginBottom: 17 }, onboardingTitle: { color: COLORS.ink, fontSize: 26, lineHeight: 32, fontWeight: '800', letterSpacing: -0.6, textAlign: 'center' }, onboardingSubtitle: { color: COLORS.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 9, maxWidth: 330 }, onboardingCard: { backgroundColor: COLORS.white, borderRadius: 23, padding: 17, borderWidth: 1, borderColor: COLORS.line }, onboardingFloatingButton: { position: 'absolute', right: 24, bottom: 24, width: 60, height: 60, borderRadius: 30, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.ink, shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }, onboardingSectionTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '800', marginTop: 11, marginBottom: 8 }, onboardingHint: { color: COLORS.muted, fontSize: 10, marginTop: -4, marginBottom: 10 }, onboardingOptional: { color: COLORS.muted, fontSize: 10, fontWeight: '600' }, onboardingChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }, onboardingChip: { minHeight: 35, borderRadius: 18, paddingHorizontal: 12, backgroundColor: '#FBFAF8', borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' }, onboardingChipActive: { backgroundColor: COLORS.sageDark, borderColor: COLORS.sageDark }, onboardingChipText: { color: COLORS.ink, fontSize: 11, fontWeight: '700' }, onboardingChipTextActive: { color: COLORS.white }, onboardingSizeRow: { flexDirection: 'row', gap: 8 }, onboardingSizeInput: { flex: 1 },
  styleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 5 }, styleCard: { width: '48%', minHeight: 92, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', padding: 12, justifyContent: 'space-between', overflow: 'hidden' }, styleCardActive: { borderColor: COLORS.sageDark, backgroundColor: '#EEF2EA' }, styleCardAccent: { width: 30, height: 5, borderRadius: 3, marginBottom: 13 }, styleCardCopy: { flex: 1 }, styleCardTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' }, styleCardTitleActive: { color: COLORS.sageDark }, styleCardDescription: { color: COLORS.muted, fontSize: 9, marginTop: 4 }, styleCardDescriptionActive: { color: COLORS.sageDark }, styleCardCheck: { position: 'absolute', right: 10, top: 10, width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: '#D8D2C9', alignItems: 'center', justifyContent: 'center' }, styleCardCheckActive: { borderColor: COLORS.sageDark, backgroundColor: COLORS.sageDark },
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 18 }, colorCard: { width: '22.5%', minHeight: 65, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', alignItems: 'center', justifyContent: 'center', gap: 6 }, colorCardActive: { borderColor: COLORS.sageDark, backgroundColor: '#EEF2EA' }, colorSwatch: { width: 25, height: 25, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(32,29,26,0.08)' }, colorSwatchLight: { borderColor: '#D8D2C9' }, colorCardText: { color: COLORS.ink, fontSize: 9, fontWeight: '700' }, colorCardTextActive: { color: COLORS.sageDark }, onboardingSectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 0 }, shopChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 9 }, shopChip: { minHeight: 31, borderRadius: 16, paddingHorizontal: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', justifyContent: 'center' }, shopChipActive: { borderColor: COLORS.clay, backgroundColor: '#F2E2DA' }, shopChipText: { color: COLORS.ink, fontSize: 10, fontWeight: '700' }, shopChipTextActive: { color: '#9E5543' },
  brandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 }, brandCard: { width: '48%', height: 82, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', alignItems: 'center', justifyContent: 'center', position: 'relative' }, brandCardActive: { borderColor: COLORS.sageDark, backgroundColor: '#EEF2EA' }, brandLogo: { width: 110, height: 30, marginBottom: 4, alignItems: 'center', justifyContent: 'center' }, brandLogoText: { color: COLORS.ink, fontSize: 15, fontWeight: '900', letterSpacing: 1.4, textAlign: 'center' }, brandLogoTextActive: { color: COLORS.sageDark }, brandFallback: { color: COLORS.muted, fontSize: 8, fontWeight: '700', letterSpacing: 1 }, brandFallbackActive: { color: COLORS.sageDark }, brandCheck: { position: 'absolute', right: 9, top: 9, width: 19, height: 19, borderRadius: 10, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center' },
  onboardingCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }, onboardingCardEyebrow: { color: COLORS.sageDark, fontSize: 9, letterSpacing: 1.3, fontWeight: '900', marginBottom: 5 }, onboardingCardIntro: { color: COLORS.ink, fontSize: 17, fontWeight: '800' }, onboardingFieldLabel: { color: COLORS.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginBottom: 7 }, genderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 3 }, genderCard: { width: '48%', minHeight: 47, borderRadius: 13, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, genderCardActive: { backgroundColor: COLORS.sageDark, borderColor: COLORS.sageDark }, genderCardText: { color: COLORS.ink, fontSize: 11, fontWeight: '700' }, genderCardTextActive: { color: COLORS.white },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, marginBottom: 30 },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: COLORS.muted, fontWeight: '700', marginBottom: 9 },
  title: { fontSize: 31, lineHeight: 36, fontWeight: '700', color: COLORS.ink, letterSpacing: -1 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.sand, alignItems: 'center', justifyContent: 'center' }, avatarText: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  captureCard: { minHeight: 180, padding: 23, borderRadius: 26, backgroundColor: COLORS.sageDark, flexDirection: 'row', alignItems: 'flex-end', overflow: 'hidden' },
  captureCopy: { flex: 1, paddingRight: 12 }, captureKicker: { fontSize: 10, color: '#DDE7D6', fontWeight: '700', letterSpacing: 1.4, marginBottom: 15 },
  captureTitle: { color: COLORS.white, fontSize: 25, fontWeight: '700', letterSpacing: -0.6, marginBottom: 8 }, captureText: { color: '#E4E9E0', lineHeight: 20, fontSize: 14 },
  cameraButton: { width: 54, height: 54, borderRadius: 27, backgroundColor: COLORS.clay, alignItems: 'center', justifyContent: 'center' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 30, marginBottom: 14 }, sectionTitle: { fontSize: 20, color: COLORS.ink, fontWeight: '700', letterSpacing: -0.4 }, link: { fontSize: 13, color: COLORS.sageDark, fontWeight: '600' },
  categories: { gap: 12, paddingRight: 4 }, categoryCard: { width: 125, padding: 9, paddingBottom: 13, borderRadius: 18, backgroundColor: COLORS.white }, categoryImageFrame: { width: '100%', height: 106, borderRadius: 13, overflow: 'hidden', backgroundColor: COLORS.sand, marginBottom: 10 }, categoryImage: { width: '100%', height: '100%' }, carouselCount: { position: 'absolute', right: 7, bottom: 7, height: 21, borderRadius: 11, paddingHorizontal: 7, backgroundColor: 'rgba(32,29,26,0.62)', flexDirection: 'row', alignItems: 'center', gap: 4 }, carouselCountText: { color: COLORS.white, fontSize: 8, fontWeight: '800' }, cardTitle: { fontWeight: '700', fontSize: 13, color: COLORS.ink, textTransform: 'capitalize' }, cardMeta: { fontSize: 11, color: COLORS.muted, marginTop: 3 }, homeWardrobeEmpty: { minHeight: 92, borderRadius: 18, borderWidth: 1, borderColor: '#CCD3C5', backgroundColor: '#F0F3EC', padding: 14, flexDirection: 'row', alignItems: 'center' }, homeWardrobeEmptyIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, homeWardrobeEmptyCopy: { flex: 1, paddingRight: 10 }, homeWardrobeEmptyTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' }, homeWardrobeEmptyText: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: 4 },
  recommendation: { backgroundColor: COLORS.white, borderRadius: 21, padding: 10, flexDirection: 'row' }, productVisual: { width: 116, minHeight: 142, borderRadius: 15, backgroundColor: '#E5D9C9', alignItems: 'center', justifyContent: 'center' }, productEmoji: { fontSize: 48 }, matchBadge: { position: 'absolute', bottom: 8, left: 8, right: 8, borderRadius: 10, paddingVertical: 6, backgroundColor: '#F4F6F1', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }, matchText: { fontSize: 10, color: COLORS.sageDark, fontWeight: '700' },
  productInfo: { flex: 1, padding: 8, paddingLeft: 15 }, shop: { fontSize: 8, letterSpacing: 1, color: COLORS.muted, fontWeight: '700', marginBottom: 8 }, productName: { color: COLORS.ink, fontWeight: '700', fontSize: 16, marginBottom: 7 }, productReason: { color: COLORS.muted, fontSize: 12, lineHeight: 17 }, priceRow: { marginTop: 'auto', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, price: { fontSize: 15, fontWeight: '700', color: COLORS.ink }, disclosure: { textAlign: 'center', color: '#9B958E', fontSize: 9, marginTop: 9 },
  nav: { height: 78, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: '#FFFEFC', flexDirection: 'row', paddingHorizontal: 8, paddingBottom: 7 }, navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }, navLabel: { fontSize: 10, color: '#96908A', fontWeight: '600' }, navLabelActive: { color: COLORS.sageDark }, addNav: { width: 50, height: 50, borderRadius: 25, backgroundColor: COLORS.clay, alignItems: 'center', justifyContent: 'center', marginTop: -22, shadowColor: COLORS.clay, shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  empty: { flex: 1, paddingHorizontal: 34, alignItems: 'center', justifyContent: 'center' }, emptyIcon: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#E5EBE0', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }, emptyTitle: { fontSize: 25, color: COLORS.ink, fontWeight: '700', marginBottom: 10 }, emptyText: { fontSize: 14, lineHeight: 21, color: COLORS.muted, textAlign: 'center', maxWidth: 300 }, primaryButton: { marginTop: 26, backgroundColor: COLORS.clay, borderRadius: 16, paddingHorizontal: 22, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 9 }, primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  loadingScreen: { flex: 1, overflow: 'hidden', backgroundColor: COLORS.paper }, preparationScreen: { flex: 1, overflow: 'hidden', backgroundColor: '#F3F5F0' }, loadingContent: { flex: 1, zIndex: 2, paddingHorizontal: 34, alignItems: 'center', justifyContent: 'center' }, loadingEyebrow: { color: COLORS.sageDark, fontSize: 10, fontWeight: '800', letterSpacing: 1.7, marginBottom: 22 }, loadingIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.clay, alignItems: 'center', justifyContent: 'center', marginBottom: 26, shadowColor: COLORS.clay, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 }, preparationIcon: { width: 76, height: 76, borderRadius: 24, backgroundColor: COLORS.sageDark, alignItems: 'center', justifyContent: 'center', marginBottom: 26, shadowColor: COLORS.sageDark, shadowOpacity: 0.24, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 }, loadingTitle: { color: COLORS.ink, fontSize: 25, lineHeight: 32, fontWeight: '700', textAlign: 'center', minHeight: 64, maxWidth: 310 }, loadingText: { color: COLORS.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 300, marginTop: 10 }, loadingSpinner: { marginTop: 28 }, loadingDecorationTop: { position: 'absolute', width: 260, height: 260, borderRadius: 130, backgroundColor: '#E6ECE1', top: -110, right: -85 }, loadingDecorationBottom: { position: 'absolute', width: 220, height: 220, borderRadius: 110, backgroundColor: '#F0D9CF', bottom: -105, left: -80 },
  addScroll: { padding: 20, paddingBottom: 40 }, addHeader: { marginTop: 10, marginBottom: 24 }, addIntro: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginTop: 10, maxWidth: 340 },
  stepScroll: { padding: 20, paddingBottom: 44 }, backButton: { alignSelf: 'flex-start', height: 40, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 3, marginBottom: 16 }, backButtonText: { color: COLORS.ink, fontSize: 13, fontWeight: '700' }, stepImage: { width: '100%', height: 230, borderRadius: 22, backgroundColor: COLORS.sand, marginBottom: 2 }, reviewHero: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.white, borderRadius: 20, padding: 10, marginBottom: 6 }, reviewImage: { width: 88, height: 112, borderRadius: 14, backgroundColor: COLORS.sand }, reviewHeroCopy: { flex: 1, paddingHorizontal: 15 }, reviewHeroTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '700', marginBottom: 5 }, reviewHeroText: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  duplicateScroll: { padding: 20, paddingBottom: 42 }, duplicateTitle: { color: COLORS.ink, fontSize: 27, lineHeight: 34, fontWeight: '700', marginTop: 7 }, duplicateIntro: { color: COLORS.muted, fontSize: 13, lineHeight: 20, marginTop: 9, maxWidth: 345 }, duplicateCounter: { alignSelf: 'flex-start', backgroundColor: '#E8EEE3', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginTop: 16, marginBottom: 13 }, duplicateCounterText: { color: COLORS.sageDark, fontSize: 9, fontWeight: '800' }, comparisonRow: { flexDirection: 'row', alignItems: 'center' }, comparisonColumn: { flex: 1, alignSelf: 'flex-start' }, comparisonLabel: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1, marginBottom: 7 }, comparisonImage: { width: '100%', height: 230, borderRadius: 17, backgroundColor: COLORS.sand }, bestPhotoBadge: { position: 'absolute', left: 7, bottom: 7, height: 23, borderRadius: 12, backgroundColor: COLORS.sageDark, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }, bestPhotoBadgeText: { color: COLORS.white, fontSize: 8, fontWeight: '800' }, comparisonName: { color: COLORS.ink, fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 9 }, comparisonUses: { color: COLORS.clay, fontSize: 9, fontWeight: '800', marginTop: 4 }, comparisonDivider: { width: 38, alignItems: 'center' }, comparisonVs: { color: COLORS.muted, fontSize: 9, fontWeight: '900' }, duplicateClues: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#E8EEE3', borderRadius: 15, padding: 13, marginTop: 18, marginBottom: 14 }, duplicateCluesText: { flex: 1, color: COLORS.sageDark, fontSize: 10, lineHeight: 15 }, sameGarmentButton: { minHeight: 58, borderRadius: 17, backgroundColor: COLORS.sageDark, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16 }, sameGarmentButtonTitle: { color: COLORS.white, fontSize: 13, fontWeight: '800' }, sameGarmentButtonText: { color: '#DDE5D8', fontSize: 9, marginTop: 3 }, differentGarmentButton: { minHeight: 58, borderRadius: 17, borderWidth: 1, borderColor: '#BFC8B8', backgroundColor: COLORS.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16, marginTop: 10 }, differentGarmentButtonTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' }, differentGarmentButtonText: { color: COLORS.muted, fontSize: 9, marginTop: 3 },
  galleryPicker: { minHeight: 330, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#BFC8B8', borderRadius: 26, backgroundColor: '#F0F3EC', alignItems: 'center', justifyContent: 'center', padding: 24 }, galleryIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginBottom: 18 }, galleryTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '700', marginBottom: 7 }, galleryText: { color: COLORS.muted, fontSize: 12, marginBottom: 24 }, galleryAction: { backgroundColor: COLORS.clay, borderRadius: 15, paddingHorizontal: 19, paddingVertical: 13, flexDirection: 'row', gap: 9, alignItems: 'center' }, galleryActionText: { color: COLORS.white, fontSize: 14, fontWeight: '700' },
  previewFrame: { height: 430, borderRadius: 26, overflow: 'hidden', backgroundColor: COLORS.sand }, previewImage: { width: '100%', height: '100%' }, removeImage: { position: 'absolute', top: 14, right: 14, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' }, imageReady: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#E8EEE3', borderRadius: 17, padding: 14, marginTop: 14 }, readyIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginRight: 11 }, readyCopy: { flex: 1 }, readyTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' }, readyText: { color: COLORS.muted, fontSize: 11, marginTop: 3 }, secondaryButton: { height: 50, marginTop: 12, borderRadius: 15, borderWidth: 1, borderColor: '#CCD3C5', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, secondaryButtonText: { color: COLORS.sageDark, fontWeight: '700', fontSize: 13 }, privacyNote: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7, marginTop: 20, paddingHorizontal: 20 }, privacyText: { color: COLORS.muted, fontSize: 10, textAlign: 'center' },
  analyzeButton: { height: 54, marginTop: 12, borderRadius: 16, backgroundColor: COLORS.clay, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 }, analyzeButtonText: { color: COLORS.white, fontWeight: '700', fontSize: 14 }, buttonDisabled: { opacity: 0.65 },
  analysisNote: { color: COLORS.muted, fontSize: 10, textAlign: 'center', marginTop: 9 }, peoplePicker: { backgroundColor: COLORS.white, borderRadius: 20, padding: 16, marginTop: 16 }, peoplePickerIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#E8EEE3', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }, peoplePickerTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700', marginBottom: 5 }, peoplePickerText: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginBottom: 13 }, personOption: { minHeight: 72, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 10, marginTop: 8, flexDirection: 'row', alignItems: 'center' }, personOptionSelected: { borderColor: COLORS.sageDark, backgroundColor: '#F1F4EE' }, personAvatar: { width: 52, height: 52, borderRadius: 26, overflow: 'hidden', backgroundColor: COLORS.sand, alignItems: 'center', justifyContent: 'center', marginRight: 11 }, personAvatarSelected: { backgroundColor: COLORS.sageDark }, faceThumbnail: { width: '100%', height: '100%' }, personAvatarText: { color: COLORS.ink, fontSize: 12, fontWeight: '800' }, personAvatarTextSelected: { color: COLORS.white }, personCopy: { flex: 1 }, personTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' }, personMeta: { color: COLORS.muted, fontSize: 10, marginTop: 3, textTransform: 'capitalize' },
  results: { marginTop: 24 }, resultsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }, resultsTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' }, betaBadge: { backgroundColor: '#E7ECE2', borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4 }, betaText: { color: COLORS.sageDark, fontSize: 8, fontWeight: '800', letterSpacing: 1 }, resultCard: { backgroundColor: COLORS.white, borderRadius: 16, padding: 13, marginBottom: 9, flexDirection: 'row', alignItems: 'center' }, resultNumber: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.sand, alignItems: 'center', justifyContent: 'center', marginRight: 11 }, resultNumberText: { color: COLORS.ink, fontSize: 12, fontWeight: '700' }, resultContent: { flex: 1 }, resultName: { color: COLORS.ink, fontSize: 14, fontWeight: '700', textTransform: 'capitalize' }, resultMeta: { color: COLORS.muted, fontSize: 11, marginTop: 4, textTransform: 'capitalize' }, confidence: { color: COLORS.sageDark, fontSize: 11, fontWeight: '700', marginLeft: 8 },
  reviewHint: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginBottom: 13 }, editCard: { backgroundColor: COLORS.white, borderRadius: 19, padding: 15, marginBottom: 12 }, editCardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 }, editCardHeadCollapsed: { marginBottom: 0 }, editCardTitle: { color: COLORS.ink, fontWeight: '700', fontSize: 15, flex: 1 }, confidenceBadge: { backgroundColor: '#EDF1E9', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 }, fieldRow: { flexDirection: 'row', gap: 10 }, fieldHalf: { flex: 1 }, fieldLabel: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1, marginBottom: 5 }, fieldInput: { minHeight: 42, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', color: COLORS.ink, fontSize: 13, paddingHorizontal: 11, marginBottom: 11 }, saveButton: { height: 56, borderRadius: 17, backgroundColor: COLORS.sageDark, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 3 }, saveButtonText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },
  editCardExcluded: { opacity: 0.62, backgroundColor: '#EEEAE5' }, includeControl: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 9, backgroundColor: '#E8EEE3', paddingHorizontal: 9, paddingVertical: 7 }, includeControlExcluded: { backgroundColor: '#E4E0DB' }, includeControlText: { color: COLORS.sageDark, fontSize: 9, fontWeight: '800' }, includeControlTextExcluded: { color: COLORS.muted }, excludedNotice: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: -6, marginBottom: 12 },
  materialSection: { borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 12, marginTop: 2 }, materialHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 11 }, materialTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '700' }, materialConfidence: { color: COLORS.sageDark, fontSize: 9, fontWeight: '700' },
  wardrobeScroll: { padding: 20, paddingBottom: 40 }, wardrobeHeader: { marginTop: 10, marginBottom: 18 }, categoryFilters: { gap: 8, paddingRight: 14, marginBottom: 16 }, categoryFilter: { height: 38, borderRadius: 19, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 7 }, categoryFilterActive: { borderColor: COLORS.sageDark, backgroundColor: COLORS.sageDark }, categoryFilterText: { color: COLORS.ink, fontSize: 11, fontWeight: '700', textTransform: 'capitalize' }, categoryFilterTextActive: { color: COLORS.white }, categoryFilterCount: { color: COLORS.muted, fontSize: 9, fontWeight: '800' }, filterSummary: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, filteredCount: { color: COLORS.muted, fontSize: 10, fontWeight: '700' }, filterButton: { height: 36, borderRadius: 18, borderWidth: 1, borderColor: '#BFC8B8', paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.white }, filterButtonActive: { borderColor: COLORS.sageDark, backgroundColor: COLORS.sageDark }, filterButtonText: { color: COLORS.sageDark, fontSize: 11, fontWeight: '800' }, filterButtonTextActive: { color: COLORS.white }, wardrobeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 }, wardrobeItem: { width: '48%', borderRadius: 18, overflow: 'hidden', backgroundColor: COLORS.white }, wardrobeImage: { width: '100%', height: 190, backgroundColor: COLORS.sand }, wardrobeInfo: { padding: 12 }, wardrobeName: { color: COLORS.ink, fontSize: 14, fontWeight: '700' }, wardrobeMeta: { color: COLORS.muted, fontSize: 10, marginTop: 5, textTransform: 'capitalize' }, wardrobeMaterial: { color: COLORS.sageDark, fontSize: 9, marginTop: 5, textTransform: 'capitalize' }, wardrobeCardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }, stylePill: { alignSelf: 'flex-start', backgroundColor: '#E8EEE3', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, marginTop: 9 }, stylePillText: { color: COLORS.sageDark, fontSize: 9, fontWeight: '700', textTransform: 'capitalize' }, wearBadge: { minWidth: 28, height: 22, borderRadius: 11, backgroundColor: '#F2E2DA', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginTop: 9 }, wearBadgeText: { color: COLORS.clay, fontSize: 9, fontWeight: '800' },
  filterModalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,29,26,0.38)' }, filterModalDismiss: { flex: 1 }, filterModal: { maxHeight: '78%', backgroundColor: COLORS.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 }, filterModalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }, filterModalTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '700' }, filterModalSubtitle: { color: COLORS.muted, fontSize: 11, marginTop: 4 }, filterClose: { width: 38, height: 38, borderRadius: 19, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' }, filterGroupTitle: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 9, marginTop: 4 }, filterOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }, filterOption: { minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }, filterOptionActive: { borderColor: COLORS.sageDark, backgroundColor: COLORS.sageDark }, filterOptionText: { color: COLORS.ink, fontSize: 11, fontWeight: '700', textTransform: 'capitalize' }, filterOptionTextActive: { color: COLORS.white }, filterActions: { flexDirection: 'row', gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.line }, clearFilterButton: { height: 50, paddingHorizontal: 19, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' }, clearFilterText: { color: COLORS.muted, fontSize: 12, fontWeight: '800' }, applyFilterButton: { height: 50, borderRadius: 15, backgroundColor: COLORS.clay, flex: 1, alignItems: 'center', justifyContent: 'center' }, applyFilterText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  detailBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(32,29,26,0.42)' }, garmentDetail: { backgroundColor: COLORS.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 28 }, garmentDetailTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '700', marginTop: 5, maxWidth: 280 }, garmentDetailImage: { width: '100%', height: 300, borderRadius: 20, backgroundColor: COLORS.sand }, wearSummary: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#E8EEE3', borderRadius: 17, padding: 15, marginTop: 15 }, wearSummaryIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, wearSummaryCount: { color: COLORS.ink, fontSize: 16, fontWeight: '800' }, wearSummaryText: { color: COLORS.muted, fontSize: 11, marginTop: 3 }, garmentDetailMeta: { color: COLORS.muted, fontSize: 11, lineHeight: 17, marginTop: 14, textTransform: 'capitalize' }, detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 }, editGarmentButton: { width: '100%', height: 48, borderRadius: 14, backgroundColor: COLORS.sageDark, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, editGarmentButtonText: { color: COLORS.white, fontSize: 11, fontWeight: '800' }, rotateImageButton: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: '#BFC8B8', backgroundColor: COLORS.white, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, mergeButton: { flex: 1, height: 48, borderRadius: 14, borderWidth: 1, borderColor: '#BFC8B8', backgroundColor: COLORS.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, mergeButtonText: { color: COLORS.sageDark, fontSize: 11, fontWeight: '800' }, deleteButton: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: '#DFC4BF', backgroundColor: '#FCF4F2', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, deleteButtonText: { color: '#A54E43', fontSize: 11, fontWeight: '800' }, mergeSheet: { maxHeight: '78%', backgroundColor: COLORS.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 28 }, mergeList: { gap: 9, paddingBottom: 8 }, mergeOption: { minHeight: 76, borderRadius: 16, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, padding: 9, flexDirection: 'row', alignItems: 'center' }, mergeOptionImage: { width: 58, height: 58, borderRadius: 11, backgroundColor: COLORS.sand, marginRight: 11 }, mergeOptionCopy: { flex: 1 }, mergeOptionTitle: { color: COLORS.ink, fontSize: 12, fontWeight: '800' }, mergeOptionMeta: { color: COLORS.muted, fontSize: 9, marginTop: 5, textTransform: 'capitalize' }, noMergeOptions: { color: COLORS.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', paddingVertical: 32 }, editGarmentSheet: { height: '88%', backgroundColor: COLORS.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 24 }, saveEditButton: { height: 52, borderRadius: 16, backgroundColor: COLORS.clay, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 12 }, saveEditButtonText: { color: COLORS.white, fontSize: 12, fontWeight: '800' },
  outfitEvaluation: { backgroundColor: '#EEF2EA', borderRadius: 19, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#DCE5D7' }, outfitEvaluationHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 }, evaluationEyebrow: { color: COLORS.sageDark, fontSize: 9, fontWeight: '800', letterSpacing: 1.1, marginBottom: 4 }, evaluationTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '700' }, evaluationScore: { width: 58, height: 58, borderRadius: 29, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginLeft: 10 }, evaluationScoreValue: { color: COLORS.sageDark, fontSize: 21, fontWeight: '800', lineHeight: 23 }, evaluationScoreMax: { color: COLORS.muted, fontSize: 9 }, evaluationSummary: { color: COLORS.ink, fontSize: 12, lineHeight: 18, marginBottom: 5 }, evaluationBlock: { marginTop: 10 }, evaluationBlockTitle: { color: COLORS.ink, fontSize: 12, fontWeight: '800', marginBottom: 6 }, evaluationRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 5 }, evaluationRowText: { flex: 1, color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  noticeBackdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 26, backgroundColor: 'rgba(32,29,26,0.42)' }, noticeCard: { width: '100%', maxWidth: 360, backgroundColor: COLORS.paper, borderRadius: 24, padding: 22, alignItems: 'center' }, noticeIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, noticeTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '800', textAlign: 'center' }, noticeMessage: { color: COLORS.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 9 }, noticeActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 9, marginTop: 20, width: '100%' }, noticeAction: { minHeight: 45, borderRadius: 14, borderWidth: 1, borderColor: '#C9D2C3', backgroundColor: COLORS.white, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }, noticeActionPrimary: { borderColor: COLORS.sageDark, backgroundColor: COLORS.sageDark }, noticeActionDestructive: { borderColor: '#D8AAA2', backgroundColor: '#FCF1EF' }, noticeActionText: { color: COLORS.sageDark, fontSize: 12, fontWeight: '800' }, noticeActionTextPrimary: { color: COLORS.white }, noticeActionTextDestructive: { color: '#A54E43' },
  onboardingDots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 12, marginBottom: 2 }, onboardingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.line }, onboardingDotActive: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.clay }, onboardingDotComplete: { backgroundColor: COLORS.sageDark },
  brandSearchWrap: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12 }, brandSearch: { flex: 1, height: '100%', color: COLORS.ink, fontSize: 13 }, brandEmpty: { color: COLORS.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', paddingVertical: 18 }, feedbackOptions: { gap: 8, marginBottom: 12 }, feedbackOption: { minHeight: 66, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FBFAF8', paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }, feedbackOptionActive: { backgroundColor: '#EEF2EA', borderColor: '#BFCDB7' }, feedbackOptionIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' }, feedbackOptionCopy: { flex: 1 }, feedbackOptionTitle: { color: COLORS.ink, fontSize: 12, fontWeight: '800' }, feedbackOptionText: { color: COLORS.muted, fontSize: 9, marginTop: 3 },
});
