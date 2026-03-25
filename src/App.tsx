import React, { useState, useEffect, useRef } from 'react';
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { ShieldCheck, Cloud, Upload, Download, Lock, Plus, Search, Copy, Trash2, Edit2, History, CheckCircle2, AlertCircle, RefreshCw, Eye, EyeOff, Clock, LogOut } from 'lucide-react';
import { auth, db } from './firebase';

const appId = 'my-blockchain-vault-app';

// --- [유틸리티] 암호화 및 해시 함수 (AES-256 적용) ---
async function generateHash(index, prevHash, timestamp, data) {
  const message = `${index}${prevHash}${timestamp}${data}`;
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

const deriveAESKey = async (keyMaterial, salt) => {
  return crypto.subtle.deriveKey(
    {name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256"},
    keyMaterial, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]
  );
};

const encryptData = async (text, keyMaterial) => {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveAESKey(keyMaterial, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt({name: "AES-GCM", iv: iv}, key, enc.encode(text));

    const combined = new Uint8Array(16 + 12 + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(new Uint8Array(encrypted), 16 + 12);

    let binary = '';
    for (let i = 0; i < combined.byteLength; i++) {
      binary += String.fromCharCode(combined[i]);
    }
    return btoa(binary);
  } catch (e) { return ""; }
};

const decryptData = async (base64, keyMaterial) => {
  try {
    const str = atob(base64);
    const combined = new Uint8Array(str.length);
    for(let i=0; i<str.length; i++) combined[i] = str.charCodeAt(i);

    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const data = combined.slice(28);

    const key = await deriveAESKey(keyMaterial, salt);
    const decrypted = await crypto.subtle.decrypt({name: "AES-GCM", iv: iv}, key, data);

    return new TextDecoder().decode(decrypted);
  } catch (e) { return null; }
};

const generateId = () => Date.now().toString(36) + Math.random().toString(36).substring(2);

export default function App() {
  // 클라우드 유저 상태
  const [user, setUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const [cryptoKey, setCryptoKey] = useState(null);
  const [inputKey, setInputKey] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [chain, setChain] = useState([]);
  const [hasExistingChain, setHasExistingChain] = useState(false);
  
  // 입력 폼 및 UI 상태
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [importData, setImportData] = useState(null);
  
  // 과거 이력 조회용 상태
  const [historyItem, setHistoryItem] = useState(null); 
  const [itemHistoryLog, setItemHistoryLog] = useState([]);

  const [loginError, setLoginError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [isChainValid, setIsChainValid] = useState(null);
  const [activeTab, setActiveTab] = useState('latest');
  const [showPassword, setShowPassword] = useState({});
  
  const [decryptedChain, setDecryptedChain] = useState([]);
  const fileInputRef = useRef(null);

  // 보안 로직 상태
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);

  // [클라우드 연동] 계정 인증 초기화
  useEffect(() => {
    if (!auth) {
      setIsAuthReady(true);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const checkData = async () => {
          let exists = false;
          if (db) {
            try {
              const docRef = doc(db, 'artifacts', appId, 'users', u.uid, 'vault_data', 'chain_doc');
              const snapshot = await getDoc(docRef);
              if (snapshot.exists()) exists = true;
            } catch (e) {}
          }
          if (!exists) {
            if (sessionStorage.getItem(`my_blockchain_db_v4_${u.uid}`)) exists = true;
            else if (sessionStorage.getItem('my_blockchain_db_v4_local')) exists = true;
          }
          setHasExistingChain(exists);
          setIsAuthReady(true);
        };
        checkData();
      } else {
        setIsUnlocked(false);
        setCryptoKey(null);
        setInputKey('');
        setChain([]);
        setHasExistingChain(!!sessionStorage.getItem('my_blockchain_db_v4_local'));
        setIsAuthReady(true);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    if (!auth) {
      setLoginError("클라우드 환경이 구성되지 않았습니다.");
      return;
    }
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      setLoginError('');
    } catch (error) {
      console.error("Login error:", error);
      setLoginError("구글 로그인에 실패했습니다.");
    }
  };

  const handleLogout = async () => {
    if (auth) {
      await signOut(auth);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("⚠️ 모든 데이터(클라우드 및 로컬)가 영구적으로 삭제됩니다. 계속하시겠습니까?")) return;
    
    setStatusMsg('데이터 초기화 중...');
    
    // 1. Firestore 삭제
    if (user && db) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'vault_data', 'chain_doc');
        await deleteDoc(docRef);
      } catch (err) {
        console.error("Firestore delete failed", err);
      }
    }
    
    // 2. LocalStorage 삭제
    const keys = [
      'my_blockchain_db_v4',
      'my_blockchain_db_v4_local',
      user ? `my_blockchain_db_v4_${user.uid}` : null
    ].filter(Boolean);
    
    keys.forEach(k => sessionStorage.removeItem(k));
    
    // 3. 상태 초기화
    setChain([]);
    setDecryptedChain([]);
    setIsUnlocked(false);
    setCryptoKey(null);
    setInputKey('');
    setHasExistingChain(false);
    
    setStatusMsg('✅ 모든 데이터가 초기화되었습니다.');
    setTimeout(() => setStatusMsg(''), 3000);
  };

  // [로컬 확인] 초기 진입 시 기존 데이터 마이그레이션
  useEffect(() => {
    const oldData = sessionStorage.getItem('my_blockchain_db_v4');
    if (oldData) {
      sessionStorage.setItem('my_blockchain_db_v4_local', oldData);
      sessionStorage.removeItem('my_blockchain_db_v4');
    }
  }, []);

  // [보안 복호화] 체인이 갱신될 때마다 화면용 데이터 복호화
  useEffect(() => {
    const decryptEntireChain = async () => {
      if (!isUnlocked || chain.length === 0 || !cryptoKey) return;
      const decrypted = await Promise.all(chain.map(async (block) => {
        if (block.index === 0) return { ...block, parsedData: null };
        const dec = await decryptData(block.data, cryptoKey);
        let parsedData = null;
        if (dec) {
          try { parsedData = JSON.parse(dec); } catch (e) {}
        }
        return { ...block, parsedData };
      }));
      setDecryptedChain(decrypted);
    };
    decryptEntireChain();
  }, [chain, isUnlocked, cryptoKey]);

  // [클라우드 동기화] 실시간 수신 리스너
  useEffect(() => {
    if (!user || !isUnlocked || !db) return;
    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'vault_data', 'chain_doc');
    
    const unsub = onSnapshot(docRef, (snapshot) => {
       if (snapshot.exists()) {
           const cloudChain = snapshot.data().chain;
           if (JSON.stringify(chain) !== JSON.stringify(cloudChain)) {
               setChain(cloudChain);
               const storageKey = user ? `my_blockchain_db_v4_${user.uid}` : 'my_blockchain_db_v4_local';
               sessionStorage.setItem(storageKey, JSON.stringify(cloudChain));
           }
       }
    }, (err) => console.error("Cloud Sync Error:", err));

    return () => unsub();
  }, [user, isUnlocked]);

  // [기능] 자동 잠금 (3분)
  useEffect(() => {
    let timeout;
    const resetTimer = () => {
      clearTimeout(timeout);
      if (isUnlocked) {
        timeout = setTimeout(() => {
          setIsUnlocked(false);
          setCryptoKey(null);
          setInputKey('');
          setLoginError('보안을 위해 3분간 조작이 없어 자동 잠금되었습니다.');
        }, 3 * 60 * 1000);
      }
    };
    if (isUnlocked) {
      window.addEventListener('mousemove', resetTimer);
      window.addEventListener('keydown', resetTimer);
      window.addEventListener('click', resetTimer);
      resetTimer();
    }
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('click', resetTimer);
    };
  }, [isUnlocked]);

  // [기능] 브루트포스 방지 (틀림 횟수 잠금)
  useEffect(() => {
    if (lockoutUntil > 0) {
      const interval = setInterval(() => {
        const remain = Math.ceil((lockoutUntil - Date.now()) / 1000);
        if (remain <= 0) {
          setLockoutUntil(0);
          setFailedAttempts(0);
          setLoginError('');
          clearInterval(interval);
        } else {
          setLoginError(`🚨 보안 잠금: ${remain}초 후 다시 시도해주세요.`);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [lockoutUntil]);

  // --- [코어 로직] 상태 및 클라우드 업데이트 공통 함수 ---
  const updateChainAndCloud = async (newChain) => {
    setChain(newChain);
    const storageKey = user ? `my_blockchain_db_v4_${user.uid}` : 'my_blockchain_db_v4_local';
    sessionStorage.setItem(storageKey, JSON.stringify(newChain));
    
    if (user && db) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'vault_data', 'chain_doc');
        await setDoc(docRef, { chain: newChain });
      } catch (err) {
        console.error("Failed to push to cloud", err);
      }
    }
  };

  const createGenesisBlock = async () => {
    const timestamp = Date.now();
    const data = "Genesis Block - 체인의 시작";
    const hash = await generateHash(0, "0", timestamp, data);
    await updateChainAndCloud([{ index: 0, timestamp, data, prevHash: "0", hash }]);
  };

  const handleUnlock = async () => {
    if (!isAuthReady) {
      setLoginError("클라우드 통신을 준비 중입니다. 잠시만 기다려주세요...");
      return;
    }
    if (inputKey.length < 4) {
      setLoginError("마스터 키는 최소 4자리 이상이어야 합니다.");
      return;
    }
    if (lockoutUntil > Date.now()) {
      setLoginError(`🚨 보안 잠금: ${Math.ceil((lockoutUntil - Date.now()) / 1000)}초 후 다시 시도해주세요.`);
      return;
    }
    
    setLoginError('');
    setStatusMsg('데이터 확인 중...');

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(inputKey), {name: "PBKDF2"}, false, ["deriveKey"]);

    let loadedChain = null;
    let isCloud = false;
    let migratedFromLocal = false;

    if (user && db) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'vault_data', 'chain_doc');
        const snapshot = await getDoc(docRef);
        
        if (snapshot.exists()) {
          loadedChain = snapshot.data().chain;
          isCloud = true;
        } else {
          let savedChain = sessionStorage.getItem(`my_blockchain_db_v4_${user.uid}`);
          if (savedChain) {
            loadedChain = JSON.parse(savedChain);
          } else {
            savedChain = sessionStorage.getItem('my_blockchain_db_v4_local');
            if (savedChain) {
              loadedChain = JSON.parse(savedChain);
              migratedFromLocal = true;
            }
          }
        }
      } catch (err) {
        let savedChain = sessionStorage.getItem(`my_blockchain_db_v4_${user.uid}`);
        if (!savedChain) savedChain = sessionStorage.getItem('my_blockchain_db_v4_local');
        if (savedChain) loadedChain = JSON.parse(savedChain);
      }
    } else {
      const savedChain = sessionStorage.getItem('my_blockchain_db_v4_local');
      if (savedChain) loadedChain = JSON.parse(savedChain);
    }

    // 키 검증 로직 (데이터가 있을 경우)
    if (loadedChain && loadedChain.length > 1) {
      // 두 번째 블록(첫 번째 실제 데이터) 복호화 시도
      const testDecrypt = await decryptData(loadedChain[1].data, keyMaterial);
      if (!testDecrypt) {
        const newFails = failedAttempts + 1;
        setFailedAttempts(newFails);
        if (newFails >= 5) {
          setLockoutUntil(Date.now() + 60 * 1000);
          setLoginError("🚨 5회 연속 실패하여 1분간 로그인이 제한됩니다.");
        } else {
          setLoginError(`❌ 마스터 키가 올바르지 않습니다. (실패: ${newFails}/5)`);
        }
        setStatusMsg('');
        return;
      }
    }

    // 성공 처리
    setFailedAttempts(0);
    setCryptoKey(keyMaterial);
    setInputKey('');
    setIsUnlocked(true);

    if (loadedChain) {
      setChain(loadedChain);
      const storageKey = user ? `my_blockchain_db_v4_${user.uid}` : 'my_blockchain_db_v4_local';
      sessionStorage.setItem(storageKey, JSON.stringify(loadedChain));
      
      if (migratedFromLocal) {
        sessionStorage.removeItem('my_blockchain_db_v4_local');
      }

      if (user && db && !isCloud) {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'vault_data', 'chain_doc');
        await setDoc(docRef, { chain: loadedChain });
        setStatusMsg('☁️ 기존 로컬 데이터를 클라우드에 백업했습니다!');
      } else if (isCloud) {
        setStatusMsg('☁️ 클라우드 동기화 완료!');
      } else {
        setStatusMsg('로컬 오프라인 모드로 실행됩니다.');
      }
    } else {
      await createGenesisBlock();
      setStatusMsg(user && db ? '☁️ 새로운 클라우드 금고가 생성되었습니다!' : '로컬 오프라인 모드로 실행됩니다.');
    }
    setTimeout(() => setStatusMsg(''), 3000);
  };

  const addBlock = async (e) => {
    e.preventDefault();
    if (!site || !username || !password) return;
    setStatusMsg('블록 생성 중...');

    const id = editingId || generateId();
    const action = editingId ? 'UPDATE' : 'CREATE';
    const rawData = JSON.stringify({ id, action, site, username, password });
    const encryptedData = await encryptData(rawData, cryptoKey);

    const prevBlock = chain[chain.length - 1];
    const index = prevBlock.index + 1;
    const timestamp = Date.now();
    const prevHash = prevBlock.hash;

    const hash = await generateHash(index, prevHash, timestamp, encryptedData);
    const newBlock = { index, timestamp, data: encryptedData, prevHash, hash };
    
    await updateChainAndCloud([...chain, newBlock]);

    resetForm();
    setStatusMsg(action === 'UPDATE' ? '수정 기록이 체인 및 클라우드에 동기화되었습니다.' : '새 데이터가 체인 및 클라우드에 동기화되었습니다.');
    setIsChainValid(null);
    setTimeout(() => setStatusMsg(''), 3000);
  };

  const confirmDeleteBlock = async () => {
    if (!itemToDelete) return;
    const item = itemToDelete;
    setItemToDelete(null);
    setStatusMsg('삭제 블록 생성 중...');

    const rawData = JSON.stringify({ id: item.id, action: 'DELETE', site: item.site, username: item.username, password: '' });
    const encryptedData = await encryptData(rawData, cryptoKey);

    const prevBlock = chain[chain.length - 1];
    const index = prevBlock.index + 1;
    const timestamp = Date.now();
    const prevHash = prevBlock.hash;

    const hash = await generateHash(index, prevHash, timestamp, encryptedData);
    const newBlock = { index, timestamp, data: encryptedData, prevHash, hash };

    await updateChainAndCloud([...chain, newBlock]);
    
    setStatusMsg('삭제 처리가 클라우드에 동기화되었습니다.');
    setIsChainValid(null);
    setTimeout(() => setStatusMsg(''), 3000);
  };

  const confirmImport = async () => {
    if(importData) {
      await updateChainAndCloud(importData);
      setImportData(null);
      
      setIsUnlocked(false);
      setCryptoKey(null);
      setInputKey('');
      setHasExistingChain(true);
      setLoginError('복원된 데이터를 클라우드에 업로드했습니다. 올바른 마스터 키로 다시 로그인해주세요.');
    }
  };

  const verifyChain = async () => {
    setStatusMsg('무결성 검사 중...');
    let isValid = true;
    for (let i = 1; i < chain.length; i++) {
      const currentBlock = chain[i];
      const prevBlock = chain[i - 1];
      const recalculatedHash = await generateHash(currentBlock.index, currentBlock.prevHash, currentBlock.timestamp, currentBlock.data);
      if (currentBlock.hash !== recalculatedHash || currentBlock.prevHash !== prevBlock.hash) {
        isValid = false; break;
      }
    }
    setIsChainValid(isValid);
    setStatusMsg(isValid ? '안전함: 데이터 무결성이 검증되었습니다.' : '경고: 체인이 훼손되었거나 데이터가 위변조되었습니다!');
  };

  const getLatestState = () => {
    const stateMap = new Map();
    decryptedChain.forEach(block => {
      if (block.index === 0) return;
      const parsed = block.parsedData;
      if (parsed && parsed.id) {
        if (parsed.action === 'DELETE') stateMap.delete(parsed.id);
        else stateMap.set(parsed.id, parsed);
      }
    });
    return Array.from(stateMap.values());
  };

  const viewHistory = (item) => {
    const history = [];
    for (let i = decryptedChain.length - 1; i >= 1; i--) {
      const block = decryptedChain[i];
      const parsed = block.parsedData;
      
      if (parsed && parsed.id === item.id) {
        history.push({
          blockIndex: block.index,
          timestamp: block.timestamp,
          action: parsed.action,
          site: parsed.site,
          username: parsed.username,
          password: parsed.password
        });
      }
    }
    
    setHistoryItem(item);
    setItemHistoryLog(history);
  };

  const handleExport = () => {
    const dataStr = JSON.stringify(chain, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my_blockchain_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedChain = JSON.parse(event.target.result as string);
        if (Array.isArray(importedChain) && importedChain.length > 0 && importedChain[0].hash) {
          setImportData(importedChain);
        } else {
          setLoginError("유효한 백업 파일이 아닙니다.");
        }
      } catch (err) {
        setLoginError("파일을 읽는 중 문제가 발생했습니다.");
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  const clipboardTimeoutRef = useRef(null);

  const handleCopy = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setStatusMsg(`${label} 복사 완료! (30초 후 자동 삭제)`);
      if (clipboardTimeoutRef.current) {
        clearTimeout(clipboardTimeoutRef.current);
      }
      clipboardTimeoutRef.current = setTimeout(() => {
        navigator.clipboard.writeText('');
        setStatusMsg('');
      }, 30000);
    }).catch(() => {
      setStatusMsg('복사 실패');
      setTimeout(() => setStatusMsg(''), 2000);
    });
  };

  const generateRandomPassword = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
    let newPw = "";
    for (let i = 0; i < 16; i++) {
      newPw += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPassword(newPw);
  };

  const startEditing = (item) => {
    setSite(item.site); setUsername(item.username); setPassword(item.password); setEditingId(item.id);
  };

  const resetForm = () => {
    setSite(''); setUsername(''); setPassword(''); setEditingId(null);
  };

  const requestDelete = (item) => {
    setItemToDelete(item);
  };

  const togglePasswordVisibility = (id) => {
    setShowPassword(prev => ({ ...prev, [id]: !prev[id] }));
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4 text-slate-500">
          <RefreshCw size={32} className="animate-spin text-blue-600" />
          <p className="font-medium">보안 환경을 준비 중입니다...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 w-full max-w-md rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 relative text-center">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
              <ShieldCheck size={32} strokeWidth={2.5} />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2 tracking-tight">안전한 비밀번호 금고</h1>
          <p className="text-slate-500 text-sm mb-8">
            상용화된 엔터프라이즈급 보안을 제공합니다.<br/>시작하려면 로그인하세요.
          </p>
          
          {loginError && (
            <div className="flex items-center gap-2 text-sm text-center mb-6 py-3 px-4 rounded-xl border bg-rose-50 text-rose-700 border-rose-100">
              <AlertCircle size={16} className="shrink-0" />
              <p className="flex-1 text-left">{loginError}</p>
            </div>
          )}

          <button 
            onClick={handleGoogleLogin} 
            className="w-full bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold py-3.5 px-4 rounded-xl transition-all shadow-sm hover:shadow-md active:scale-[0.98] flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Google 계정으로 시작하기
          </button>
        </div>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 w-full max-w-md rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 relative">
          <div className="flex justify-center mb-6 relative">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
              <ShieldCheck size={32} strokeWidth={2.5} />
            </div>
            {user && <div className="absolute top-0 right-1/2 translate-x-6 w-3.5 h-3.5 bg-emerald-500 border-2 border-white rounded-full" title="클라우드 연결됨"></div>}
          </div>
          
          <h1 className="text-2xl font-bold text-slate-900 text-center mb-2 tracking-tight">마스터 키 입력</h1>
          
          <p className="text-slate-500 text-sm text-center mb-8">
            {hasExistingChain ? '마스터 키를 입력하여 금고를 엽니다.' : '새로운 마스터 키를 설정해주세요.'}
          </p>
          
          {loginError && (
            <div className={`flex items-center gap-2 text-sm text-center mb-6 py-3 px-4 rounded-xl border ${loginError.includes('✅') || loginError.includes('복원') ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-rose-50 text-rose-700 border-rose-100'}`}>
              <AlertCircle size={16} className="shrink-0" />
              <p className="flex-1 text-left">{loginError}</p>
            </div>
          )}

          <div className="space-y-4">
            <input
              type="password"
              className="w-full bg-slate-50 border border-slate-200 text-slate-900 px-4 py-3.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-center text-lg tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="마스터 키 입력"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
              disabled={!isAuthReady || lockoutUntil > 0}
            />
            <button 
              onClick={handleUnlock} 
              disabled={!isAuthReady || lockoutUntil > 0}
              className={`w-full text-white font-semibold py-3.5 px-4 rounded-xl transition-all shadow-sm hover:shadow-md active:scale-[0.98] ${isAuthReady && lockoutUntil === 0 ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-300 cursor-not-allowed'}`}
            >
              {isAuthReady ? (lockoutUntil > 0 ? '보안 잠금 작동 중' : '잠금 해제') : '보안 환경 준비 중...'}
            </button>

            <div className="pt-4 border-t border-slate-100 mt-4 space-y-3">
              <button 
                onClick={handleReset}
                className="w-full flex items-center justify-center gap-2 text-rose-500 hover:text-rose-600 text-xs font-medium py-2 transition-colors"
              >
                <Trash2 size={14} />
                모든 데이터 초기화 (테스트용)
              </button>
            </div>
          </div>

          <div className="pt-6 mt-6 border-t border-slate-100">
            <input type="file" accept=".json" id="loginFileInput" style={{ display: 'none' }} onChange={handleImport} />
            <button onClick={() => document.getElementById('loginFileInput').click()} className="w-full bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 py-3 px-4 rounded-xl transition-colors text-sm font-medium flex justify-center items-center gap-2">
              <Upload size={16} />
              기존 백업 파일 복원
            </button>
          </div>
        </div>
        
        {importData && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white border border-slate-100 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
              <h3 className="text-xl font-bold text-slate-900 mb-2 flex items-center gap-2">
                <AlertCircle className="text-rose-500" size={24} />
                데이터 복원 경고
              </h3>
              <p className="text-slate-600 mb-6 text-sm leading-relaxed">
                기존 로컬 및 클라우드의 모든 데이터가 지워지고 백업 파일로 덮어씌워집니다. 계속하시겠습니까?
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setImportData(null)} className="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition-colors">취소</button>
                <button onClick={confirmImport} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-sm font-medium transition-colors shadow-sm">복원 덮어쓰기</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const latestDataList = getLatestState();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-center bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 shrink-0">
              <ShieldCheck size={24} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 tracking-tight">
                내 비밀번호 금고
                {user && (
                  <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-medium flex items-center gap-1.5">
                    <Cloud size={12} /> 동기화됨
                  </span>
                )}
              </h1>
              <p className="text-slate-500 text-sm mt-0.5">총 <span className="text-blue-600 font-semibold">{latestDataList.length}</span>개의 계정이 안전하게 보관되어 있습니다.</p>
            </div>
          </div>
          
          <div className="flex gap-2 mt-4 sm:mt-0 items-center">
            {user && (
              <div className="hidden sm:flex items-center gap-2 mr-2 px-3 py-1.5 bg-slate-50 rounded-lg border border-slate-100">
                <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.email}`} alt="profile" className="w-6 h-6 rounded-full" />
                <span className="text-xs font-medium text-slate-600 truncate max-w-[100px]">{user.email?.split('@')[0]}</span>
              </div>
            )}
            <input type="file" accept=".json" ref={fileInputRef} style={{ display: 'none' }} onChange={handleImport} />
            <button onClick={() => fileInputRef.current.click()} className="p-2.5 text-slate-600 hover:bg-slate-50 rounded-xl transition-colors border border-slate-200" title="파일 복원">
              <Upload size={18} />
            </button>
            <button onClick={handleExport} className="p-2.5 text-slate-600 hover:bg-slate-50 rounded-xl transition-colors border border-slate-200" title="전체 백업">
              <Download size={18} />
            </button>
            <button onClick={() => setIsUnlocked(false)} className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-sm">
              <Lock size={16} /> 잠금
            </button>
            <button onClick={handleLogout} className="p-2.5 text-slate-600 hover:bg-slate-50 rounded-xl transition-colors border border-slate-200 ml-1" title="로그아웃">
              <LogOut size={18} />
            </button>
            <button onClick={handleReset} className="p-2.5 text-rose-600 hover:bg-rose-50 rounded-xl transition-colors border border-rose-100 ml-1" title="모든 데이터 초기화">
              <Trash2 size={18} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Form & Status */}
          <div className="lg:col-span-1 space-y-6">
            <div className={`p-6 rounded-3xl border shadow-sm transition-colors ${editingId ? 'bg-blue-50/50 border-blue-200' : 'bg-white border-slate-100'}`}>
              <div className="flex justify-between items-center mb-5">
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  {editingId ? <><Edit2 size={18} className="text-blue-600"/> 정보 수정</> : <><Plus size={18} className="text-blue-600"/> 새 계정 추가</>}
                </h2>
                {editingId && <button type="button" onClick={resetForm} className="text-xs font-medium text-slate-500 hover:text-slate-700 bg-white border border-slate-200 px-2 py-1 rounded-md">취소</button>}
              </div>

              <form onSubmit={addBlock} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">사이트명 / 용도</label>
                  <input type="text" required value={site} onChange={(e) => setSite(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all" placeholder="예: Google, 네이버" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">아이디 (ID)</label>
                  <input type="text" required value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all" placeholder="user@email.com" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">비밀번호 (PW)</label>
                  <div className="flex gap-2">
                    <input type="text" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono" placeholder="비밀번호 입력" />
                    <button type="button" onClick={generateRandomPassword} className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium px-4 py-2.5 rounded-xl transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-sm">
                      <RefreshCw size={14} /> 생성
                    </button>
                  </div>
                </div>
                <button type="submit" className={`w-full text-white text-sm font-semibold py-3 rounded-xl transition-all shadow-sm hover:shadow-md active:scale-[0.98] mt-2 ${editingId ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-900 hover:bg-slate-800'}`}>
                  {editingId ? '수정 내용 저장하기' : '금고에 추가하기'}
                </button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
                <ShieldCheck size={16} className="text-slate-400" /> 보안 시스템
              </h2>
              <button onClick={verifyChain} className="w-full bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium py-2.5 rounded-xl transition-colors flex justify-center items-center gap-2 mb-3">
                <CheckCircle2 size={16} className="text-emerald-500" />
                블록체인 무결성 검증
              </button>
              {statusMsg && (
                <div className={`p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${statusMsg.includes('오류') || statusMsg.includes('실패') || statusMsg.includes('경고') ? 'bg-rose-50 text-rose-700' : statusMsg.includes('안전함') || statusMsg.includes('완료') || statusMsg.includes('동기화') ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
                  <AlertCircle size={14} className="shrink-0" />
                  <span className="flex-1">{statusMsg}</span>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Data List */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl w-fit">
              <button onClick={() => setActiveTab('latest')} className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'latest' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>최신 목록</button>
              <button onClick={() => setActiveTab('ledger')} className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'ledger' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>전체 원장</button>
            </div>

            {activeTab === 'latest' && (
              <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm min-h-[500px]">
                <div className="mb-6 relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Search size={18} className="text-slate-400" />
                  </div>
                  <input type="text" placeholder="사이트명 또는 아이디로 검색..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-slate-50 border border-slate-200 text-slate-900 rounded-2xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all" />
                </div>

                {latestDataList.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                      <Lock size={24} className="text-slate-300" />
                    </div>
                    <p className="font-medium text-slate-500">저장된 비밀번호가 없습니다.</p>
                    <p className="text-sm mt-1">왼쪽 폼에서 새 계정을 추가해보세요.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {latestDataList
                      .filter(item => item.site.toLowerCase().includes(searchTerm.toLowerCase()) || item.username.toLowerCase().includes(searchTerm.toLowerCase()))
                      .map(item => (
                      <div key={item.id} className="bg-white border border-slate-200 rounded-2xl p-5 hover:shadow-md hover:border-blue-200 transition-all group">
                        <div className="flex justify-between items-start mb-4">
                          <h3 className="text-base font-bold text-slate-900 truncate pr-2 flex items-center gap-2">
                            {item.site}
                          </h3>
                          <div className="flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => viewHistory(item)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="이력 보기">
                              <History size={16} />
                            </button>
                            <button onClick={() => startEditing(item)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="수정">
                              <Edit2 size={16} />
                            </button>
                            <button onClick={() => requestDelete(item)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="삭제">
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                        
                        <div className="space-y-3">
                          <div>
                            <p className="text-[11px] font-semibold text-slate-400 mb-1 uppercase tracking-wider">ID</p>
                            <div className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-xl group/item">
                              <p className="text-sm text-slate-700 truncate pr-2 font-medium">{item.username}</p>
                              <button onClick={() => handleCopy(item.username, '아이디')} className="text-slate-400 hover:text-blue-600 transition-colors opacity-0 group-hover/item:opacity-100" title="복사">
                                <Copy size={14} />
                              </button>
                            </div>
                          </div>
                          <div>
                            <p className="text-[11px] font-semibold text-slate-400 mb-1 uppercase tracking-wider">Password</p>
                            <div className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-xl group/item">
                              <p className="text-sm text-slate-700 font-mono truncate pr-2">
                                {showPassword[item.id] ? item.password : '••••••••••••'}
                              </p>
                              <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                <button onClick={() => togglePasswordVisibility(item.id)} className="p-1 text-slate-400 hover:text-blue-600 transition-colors" title="보기/숨기기">
                                  {showPassword[item.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                                <button onClick={() => handleCopy(item.password, '비밀번호')} className="p-1 text-slate-400 hover:text-blue-600 transition-colors" title="복사">
                                  <Copy size={14} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'ledger' && (
              <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm relative h-[600px] overflow-y-auto">
                <div className="absolute left-[2.25rem] top-8 bottom-8 w-px bg-slate-200 z-0"></div>
                <div className="space-y-6 relative z-10">
                  {decryptedChain.map((block) => {
                    const parsedData = block.parsedData;
                    return (
                      <div key={block.index} className="flex gap-4 items-start">
                        <div className="w-8 h-8 rounded-full bg-white border-2 border-slate-200 flex items-center justify-center font-bold text-slate-500 text-xs shrink-0 mt-1 z-10">
                          {block.index}
                        </div>
                        <div className="flex-1 bg-white border border-slate-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
                          <div className="flex justify-between items-center mb-3">
                            <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                              <Clock size={12} />
                              {new Date(block.timestamp).toLocaleString()}
                            </span>
                            {parsedData && parsedData.action === 'UPDATE' && <span className="text-[10px] font-bold bg-blue-50 text-blue-600 px-2.5 py-1 rounded-lg">업데이트</span>}
                            {parsedData && parsedData.action === 'DELETE' && <span className="text-[10px] font-bold bg-rose-50 text-rose-600 px-2.5 py-1 rounded-lg">삭제됨</span>}
                            {parsedData && parsedData.action === 'CREATE' && <span className="text-[10px] font-bold bg-emerald-50 text-emerald-600 px-2.5 py-1 rounded-lg">신규 생성</span>}
                          </div>
                          <div className="bg-slate-50 rounded-xl p-3 mb-4 text-[11px] font-mono text-slate-500 break-all border border-slate-100">
                            <p className="mb-1"><span className="text-slate-400 font-semibold mr-1">Prev:</span> {block.prevHash}</p>
                            <p><span className="text-blue-500 font-semibold mr-1">Hash:</span> {block.hash}</p>
                          </div>
                          <div className="text-sm text-slate-700">
                            {block.index === 0 ? <span className="text-slate-400 italic flex items-center gap-2"><ShieldCheck size={16}/> 제네시스 블록 (시스템 자동 생성)</span> : parsedData ? (
                              parsedData.action === 'DELETE' ? <span className="text-rose-500 italic flex items-center gap-2"><Trash2 size={16}/> [{parsedData.site}] 계정 정보가 삭제 처리됨</span> : (
                                <div className="grid grid-cols-3 gap-4 bg-slate-50/50 p-3 rounded-xl">
                                  <div><span className="text-[10px] font-semibold text-slate-400 block uppercase mb-1">Site</span><span className="font-medium">{parsedData.site}</span></div>
                                  <div><span className="text-[10px] font-semibold text-slate-400 block uppercase mb-1">ID</span>{parsedData.username}</div>
                                  <div><span className="text-[10px] font-semibold text-slate-400 block uppercase mb-1">PW</span><span className="font-mono text-slate-600">{parsedData.password}</span></div>
                                </div>
                              )
                            ) : <span className="text-rose-500 flex items-center gap-2"><AlertCircle size={16}/> 복호화 실패 (키 오류)</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            
          </div>
        </div>
      </div>

      {/* Modals */}
      {itemToDelete && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-100 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900 mb-2 flex items-center gap-2">
              <Trash2 className="text-rose-500" size={24} />
              항목 삭제
            </h3>
            <p className="text-slate-600 mb-6 text-sm">정말 '<span className="text-slate-900 font-bold">{itemToDelete.site}</span>' 항목을 삭제하시겠습니까?</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setItemToDelete(null)} className="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition-colors">취소</button>
              <button onClick={confirmDeleteBlock} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-sm font-medium transition-colors shadow-sm">삭제 확인</button>
            </div>
          </div>
        </div>
      )}

      {importData && isUnlocked && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-100 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900 mb-2 flex items-center gap-2">
              <AlertCircle className="text-rose-500" size={24} />
              데이터 복원 경고
            </h3>
            <p className="text-slate-600 mb-6 text-sm leading-relaxed">기존 메모장 및 클라우드 데이터가 모두 덮어씌워집니다. 진행하시겠습니까?</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setImportData(null)} className="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition-colors">취소</button>
              <button onClick={confirmImport} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-sm font-medium transition-colors shadow-sm">복원 덮어쓰기</button>
            </div>
          </div>
        </div>
      )}

      {historyItem && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-100 rounded-3xl max-w-lg w-full shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
            
            <div className="p-6 border-b border-slate-100 flex justify-between items-center shrink-0 bg-slate-50/50">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <History className="text-blue-600" size={20} />
                {historyItem.site} 변경 이력
              </h3>
              <button onClick={() => setHistoryItem(null)} className="text-slate-400 hover:text-slate-600 bg-white border border-slate-200 p-1.5 rounded-lg transition-colors">
                <Plus className="rotate-45" size={20} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto relative">
              <div className="absolute left-[2.25rem] top-8 bottom-8 w-px bg-slate-200 z-0"></div>
              
              <div className="space-y-6 relative z-10">
                {itemHistoryLog.map((log, index) => (
                  <div key={log.blockIndex} className="flex gap-4 items-start">
                    <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 mt-1 z-10 bg-white ${index === 0 ? 'border-blue-500 text-blue-600' : 'border-slate-200 text-slate-400'}`}>
                      #{log.blockIndex}
                    </div>

                    <div className={`flex-1 rounded-2xl p-5 border ${index === 0 ? 'bg-blue-50/30 border-blue-100 shadow-sm' : 'bg-white border-slate-100'}`}>
                      <div className="flex justify-between items-center mb-3">
                        <span className={`text-[10px] font-bold px-2.5 py-1 rounded-lg ${index === 0 ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                          {index === 0 ? '최신 상태' : '과거 기록'}
                        </span>
                        <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                          <Clock size={12} />
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
                      </div>
                      
                      <div className="space-y-3 mt-4">
                        <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Action</span>
                          <span className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                            {log.action === 'CREATE' ? <><Plus size={14} className="text-emerald-500"/> 최초 생성</> : log.action === 'UPDATE' ? <><RefreshCw size={14} className="text-blue-500"/> 정보 수정</> : <><Trash2 size={14} className="text-rose-500"/> 삭제됨</>}
                          </span>
                        </div>
                        {log.action !== 'DELETE' && (
                          <>
                            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">ID</span>
                              <span className="text-sm font-medium text-slate-700">{log.username}</span>
                            </div>
                            <div className="flex justify-between items-center pt-1">
                              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">PW</span>
                              <span className={`font-mono text-sm ${index === 0 ? 'text-slate-700' : 'text-slate-400 line-through'}`}>{log.password}</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="p-4 border-t border-slate-100 bg-slate-50 shrink-0 text-center">
              <p className="text-xs font-medium text-slate-500 flex items-center justify-center gap-1.5">
                <ShieldCheck size={14} /> 블록체인 장부에 기록된 불변의 위변조 방지 데이터입니다.
              </p>
            </div>
            
          </div>
        </div>
      )}

    </div>
  );
}
