import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// databaseId를 환경변수에서 직접 꺼내서 넘김
export const db = getFirestore(app, import.meta.env.VITE_FIREBASE_DATABASE_ID);
