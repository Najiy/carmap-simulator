import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyArn0vRkDT4wNi5pMlYjdso1zT60t8v9uI",
  authDomain: "carmap-2.firebaseapp.com",
  // multiplayer rendezvous + live race streaming (WebSocket transport).
  // If you created the RTDB instance in another region, update this URL.
  databaseURL: "https://carmap-2-default-rtdb.firebaseio.com",
  projectId: "carmap-2",
  storageBucket: "carmap-2.firebasestorage.app",
  messagingSenderId: "254431020114",
  appId: "1:254431020114:web:91b3eddee5c19a25fb0b8b",
  measurementId: "G-3LKH0ELXJF",
};

export const app = initializeApp(firebaseConfig);

// analytics is unavailable in some environments (ad blockers, non-https) —
// don't let it take the app down
isSupported()
  .then((ok) => {
    if (ok) getAnalytics(app);
  })
  .catch(() => {});
