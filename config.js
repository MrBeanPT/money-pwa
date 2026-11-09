// Public configuration (not secret). The OAuth Client ID only works from the authorised origin.
window.MONEY_CONFIG = {
  GOOGLE_CLIENT_ID: "", // e.g. 1234567890-abc.apps.googleusercontent.com
  INBOX_FOLDER: "Money Inbox", // folder at the root of "My Drive"
  // drive: needed to read lookups.json written by the PC (via Drive for desktop) and to write into a folder
  // the app did not create. The app only ever touches the INBOX_FOLDER.
  SCOPE: "https://www.googleapis.com/auth/drive",
};
