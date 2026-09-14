# Configuración de anuncios

La app Android muestra un banner adaptativo durante el análisis inicial del outfit y otro durante la preparación del armario. En iOS no se inicializa ni se solicita publicidad.

## Variables de entorno

Configura el App ID de la aplicación Android en AdMob:

```dotenv
EXPO_PUBLIC_ADMOB_ANDROID_APP_ID=ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx
```

Configura una unidad de banner distinta para cada pantalla:

```dotenv
EXPO_PUBLIC_ADMOB_ANDROID_ANALYSIS_BANNER_ID=ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx
EXPO_PUBLIC_ADMOB_ANDROID_PREPARATION_BANNER_ID=ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx
```

En Android de desarrollo se usan siempre los anuncios de prueba oficiales de Google. Si faltan unidades de banner en una compilación de producción, no se solicita ningún anuncio. Los App ID de prueba del archivo `app.config.js` solo permiten compilar mientras se completa la configuración.

## Consentimiento y compilación

1. Crea y publica un mensaje de consentimiento europeo en **AdMob > Privacidad y mensajes**. La app consulta ese formulario antes de inicializar anuncios.
2. Crea una nueva compilación nativa; este SDK no funciona en Expo Go.
3. Antes de publicar en Android, declara en Google Play Console que la app contiene anuncios.

```bash
npx eas build --profile development
```

## app-ads.txt

El archivo `docs/app-ads.txt` autoriza a Google como vendedor directo de la publicidad de la app. Debe publicarse en la raíz del sitio web del desarrollador indicado en Google Play, de modo que sea accesible mediante una URL como:

```text
https://tu-dominio.example/app-ads.txt
```

Contenido configurado para esta cuenta de AdMob:

```text
google.com, pub-4318745151479325, DIRECT, f08c47fec0942fa0
```
