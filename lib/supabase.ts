import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Faltan EXPO_PUBLIC_SUPABASE_URL o EXPO_PUBLIC_SUPABASE_ANON_KEY.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export type DatabaseGarmentRow = {
  id: string;
  user_id: string;
  custom_name: string | null;
  category: string;
  subcategory: string;
  primary_color: string;
  secondary_colors: string[];
  styles: string[];
  pattern: string;
  brand: string;
  material_estimate: string;
  fabric_type: string;
  texture: string;
  material_confidence: number;
  confidence: number;
  image_path: string;
  thumbnail_path: string | null;
  wear_count: number;
  scan_fingerprint: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type DatabaseOutfitRow = {
  id: string;
  user_id: string;
  image_path: string;
  thumbnail_path: string | null;
  evaluation: Record<string, unknown> | null;
  style_goal: string | null;
  taken_at: string;
  created_at: string;
};
