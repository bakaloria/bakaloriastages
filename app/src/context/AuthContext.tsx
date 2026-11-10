import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { api } from "../lib/api";
import {
  auth,
  backendMode,
  db,
  isFirebaseConfigured,
  STUDENT_EMAIL_DOMAIN,
} from "../lib/firebase";
import type { Branch, Profile, RegisterInput } from "../lib/types";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  registering: boolean;
  configured: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function profileFromData(uid: string, data: Record<string, unknown>): Profile {
  const branch: Branch = data.branch === "literary" ? "literary" : "scientific";
  const role = data.role === "admin" ? "admin" : "student";
  return {
    uid,
    username: String(data.username ?? ""),
    usernameLower: String(data.usernameLower ?? ""),
    displayName: String(data.displayName ?? data.username ?? "طالب"),
    branch,
    role,
    mustChangePassword: data.mustChangePassword === true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setProfile(null);
        setLoading(false);
      } else {
        setLoading(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!user || !db) {
      setProfile(null);
      return;
    }
    const unsubscribe = onSnapshot(
      doc(db, "users", user.uid),
      (snapshot) => {
        if (snapshot.exists()) {
          setProfile(profileFromData(user.uid, snapshot.data()));
        } else {
          setProfile(null);
        }
        setLoading(false);
      },
      () => {
        // Keep any profile we already have (for example the optimistic profile
        // set right after registration). A transient listener error should not
        // turn a valid session into the "incomplete profile" screen.
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [user]);

  const login = useCallback(async (username: string, password: string) => {
    if (!auth) throw new Error("FIREBASE_NOT_CONFIGURED");
    const email = `${username.trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    if (!auth) throw new Error("FIREBASE_NOT_CONFIGURED");
    setRegistering(true);
    try {
      const result = await api.register(input);
      // Spark registration signs the new user in inside api.register so the
      // Firestore transaction can create the profile. Callable mode creates
      // the account server-side and needs an explicit client sign-in.
      if (backendMode === "functions") {
        await signInWithEmailAndPassword(auth, result.email, input.password);
      }
      // Set the profile from the just-validated form values so the UI does not
      // flash the "incomplete profile" screen while Firestore delivers the
      // first snapshot of the new user document.
      const username = input.username.trim();
      setProfile({
        uid: result.uid,
        username,
        usernameLower: username.toLowerCase(),
        displayName: input.displayName.trim() || username,
        branch: input.branch,
        role: "student",
      });
    } finally {
      setRegistering(false);
    }
  }, []);

  const logout = useCallback(async () => {
    if (!auth) return;
    await signOut(auth);
  }, []);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      registering,
      configured: isFirebaseConfigured,
      login,
      register,
      logout,
    }),
    [user, profile, loading, registering, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
