// Public configuration (not secret). The OAuth Client ID only works from the authorised origin.
window.MONEY_CONFIG = {
  GOOGLE_CLIENT_ID: "199034219151-l2qeqdf5qv6mb6l73fftqfv0t5cf5j4d.apps.googleusercontent.com",
  INBOX_FOLDER: "Money Inbox", // folder at the root of "My Drive"
  // drive: needed to read lookups.json written by the PC (via Drive for desktop) and to write into a folder
  // the app did not create. The app only ever touches the INBOX_FOLDER.
  SCOPE: "https://www.googleapis.com/auth/drive",
};
