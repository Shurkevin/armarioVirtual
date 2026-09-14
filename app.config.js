const app = require('./app.json');

const TEST_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const TEST_IOS_APP_ID = 'ca-app-pub-3940256099942544~1458002511';

module.exports = () => ({
  ...app.expo,
  plugins: [
    ...app.expo.plugins.filter((plugin) => (
      Array.isArray(plugin) ? plugin[0] : plugin
    ) !== 'react-native-google-mobile-ads'),
    [
      'react-native-google-mobile-ads',
      {
        androidAppId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID || TEST_ANDROID_APP_ID,
        // El plugin exige un valor para iOS aunque actualmente solo publiquemos Android.
        iosAppId: TEST_IOS_APP_ID,
        delayAppMeasurementInit: true,
      },
    ],
  ],
});
