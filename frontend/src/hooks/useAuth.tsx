import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  onAuthStateChanged,
  signInAnonymously,
  updateProfile,
  signOut,
  type User
} from "firebase/auth";
import { auth } from "../lib/firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  async function login(displayName: string) {
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("Devi scegliere un nickname per continuare.");
    }

    // Se c'è già un utente loggato, aggiorno solo il displayName
    if (auth.currentUser) {
      if (auth.currentUser.displayName !== trimmed) {
        await updateProfile(auth.currentUser, { displayName: trimmed });
      }
      setUser(auth.currentUser);
      return;
    }

    // Login anonimo + impostazione nickname come displayName
    const cred = await signInAnonymously(auth);
    if (cred.user) {
      await updateProfile(cred.user, { displayName: trimmed });
      setUser({ ...cred.user, displayName: trimmed } as User);
    }
  }

  async function logout() {
    await signOut(auth);
    setUser(null);
  }

  const value: AuthContextValue = {
    user,
    loading,
    login,
    logout
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth deve essere usato dentro un AuthProvider");
  }
  return ctx;
}
