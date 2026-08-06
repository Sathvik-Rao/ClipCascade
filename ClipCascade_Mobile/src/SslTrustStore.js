import { NativeModules, Platform } from 'react-native';
import { pick, isCancel } from '@react-native-documents/picker';

const { NativeBridgeModule } = NativeModules;

/*
 * Import and inspect the CA certificate used to verify the ClipCascade server, for
 * servers running behind a private or internal PKI. The certificate itself lives in
 * native app storage rather than AsyncStorage: the trust manager has to read it
 * before any JavaScript runs (the boot receiver and the headless service both open
 * connections), and keeping one source of truth avoids the two drifting apart.
 *
 * Android is implemented today. The iOS counterpart needs an RCTHTTPRequestHandler /
 * NSURLSessionDelegate override plus its own handling for the WebSocket path, and is
 * not built yet, so the login screen hides the row instead of offering a dead button.
 * Adding it later means implementing these three native methods on iOS; nothing in
 * App.js has to change.
 */
export const isCaCertificateSupported =
  Platform.OS === 'android' &&
  NativeBridgeModule != null &&
  typeof NativeBridgeModule.getCaCertificateInfo === 'function';

// Details of the currently imported certificate, or null if there is none.
export const getCaCertificate = async () => {
  if (!isCaCertificateSupported) {
    return null;
  }
  return await NativeBridgeModule.getCaCertificateInfo();
};

/*
 * Opens the file picker and imports the chosen certificate. Resolves with the new
 * certificate's details, or null if the user backed out of the picker.
 *
 * The picker is deliberately not filtered by MIME type: certificate files are handed
 * around with a wide spread of types (and often none at all), and a filter mostly
 * results in the file the user is looking at being unselectable. The file is
 * validated natively on import instead.
 */
export const importCaCertificate = async () => {
  if (!isCaCertificateSupported) {
    return null;
  }
  let picked;
  try {
    picked = await pick();
  } catch (e) {
    if (isCancel(e)) {
      return null;
    }
    throw e;
  }
  const file = picked?.[0];
  if (!file?.uri) {
    return null;
  }
  return await NativeBridgeModule.importCaCertificate(file.uri);
};

export const removeCaCertificate = async () => {
  if (!isCaCertificateSupported) {
    return;
  }
  await NativeBridgeModule.removeCaCertificate();
};

// Pulls the common name out of an RFC 2253 distinguished name, e.g.
// "CN=Homelab Root CA,O=Homelab" -> "Homelab Root CA".
const commonName = dn => {
  if (!dn) {
    return null;
  }
  const match = dn.match(/(?:^|,)\s*CN=((?:\\.|[^,\\])*)/i);
  return match ? match[1].replace(/\\(.)/g, '$1').trim() : null;
};

/*
 * One line describing the imported certificate for the login screen. The expiry is
 * shown because an expired private CA otherwise fails with a handshake error that
 * looks identical to having no certificate imported at all.
 */
export const describeCaCertificate = certificate => {
  if (!certificate) {
    return 'None (public CAs only)';
  }
  const name = commonName(certificate.subject) || certificate.subject || 'Certificate';
  const expiry = new Date(certificate.notAfter);
  const expired = expiry.getTime() < Date.now();
  const suffix = certificate.count > 1 ? ` (+${certificate.count - 1} more)` : '';
  return [
    expired ? '⚠️ ' : '',
    name,
    suffix,
    expired ? ' — expired ' : ' — expires ',
    expiry.toLocaleDateString(),
  ].join('');
};
