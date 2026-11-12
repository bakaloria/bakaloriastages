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
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { api } from "../lib/api";
import {
  auth,
  backendMode,
  db,
  isFirebaseConfigured,
  STUDENT_EMAIL_DOMAIN,
} from "../lib/firebase";
import {
  applyStudentPalette,
  DEFAULT_GLOBAL_SETTINGS,
  normalizeGlobalSettings,
} from "../lib/settings";
import type {
  Branch,
  GlobalSettings,
  Profile,
  RegisterInput,
} from "../lib/types";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  settings: GlobalSettings;
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
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
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

  useEffect(() => {
    if (!user || !db) {
      setSettings(DEFAULT_GLOBAL_SETTINGS);
      return;
    }
    return onSnapshot(
      doc(db, "settings", "global"),
      (snapshot) => {
        setSettings(
          normalizeGlobalSettings(
            snapshot.exists() ? (snapshot.data() as Partial<GlobalSettings>) : null,
          ),
        );
      },
      () => setSettings(DEFAULT_GLOBAL_SETTINGS),
    );
  }, [user]);

  useEffect(() => {
    // Apply the theme at the provider level so the login page and the logout
    // state also reset to the saved palette instead of keeping stale colors.
    applyStudentPalette(settings);
  }, [settings]);

  const login = useCallback(async (username: string, password: string) => {
    if (!auth) throw new Error("FIREBASE_NOT_CONFIGURED");
    const usernameLower = username.trim().toLowerCase();
    let email = `${usernameLower}@${STUDENT_EMAIL_DOMAIN}`;
    if (db) {
      try {
        // Firebase does not allow changing the synthetic login email without
        // verifying an inbox that does not exist. The username reservation
        // therefore stores the original Auth email so a renamed account can
        // still sign in with its new username.
        const alias = await getDoc(doc(db, "usernames", usernameLower));
        const storedEmail = alias.exists() ? alias.data().email : null;
        if (typeof storedEmail === "string" && storedEmail.includes("@")) {
          email = storedEmail;
        }
      } catch {
        // Keep the deterministic email fallback for older reservations or
        // when the alias lookup is temporarily unavailable.
      }
    }
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
      settings,
      loading,
      registering,
      configured: isFirebaseConfigured,
      login,
      register,
      logout,
    }),
    [user, profile, settings, loading, registering, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
