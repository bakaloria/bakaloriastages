import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { branchLabel } from "../lib/format";
import {
  ChartIcon,
  HomeIcon,
  LogoutIcon,
  TrophyIcon,
  UserIcon,
} from "./Icons";

const navItems = [
  { to: "/", label: "الرئيسية", icon: HomeIcon, end: true },
  { to: "/progress", label: "تقدمي", icon: ChartIcon },
  { to: "/leaderboard", label: "المتصدرون", icon: TrophyIcon },
  { to: "/account", label: "حسابي", icon: UserIcon },
];

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" role="img" aria-label="مراحل البكالوريا">
      <rect width="512" height="512" rx="112" fill="currentColor" />
      <path
        d="M120 360h88v-72h88v-72h88V144"
        fill="none"
        stroke="#f7f3ea"
        strokeWidth="40"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="384" cy="144" r="34" fill="#d4a24c" />
      <path d="M120 392h272" fill="none" stroke="#d4a24c" strokeWidth="24" strokeLinecap="round" />
    </svg>
  );
}

export function Layout() {
  const { profile, logout } = useAuth();
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="brand" aria-label="مراحل البكالوريا">
            <BrandMark />
            <span className="brand__text">
              <strong>مراحل البكالوريا</strong>
              <small>تعلّم، راجع، واكتمل</small>
            </span>
          </Link>

          <nav className="desktop-nav" aria-label="التنقل الرئيسي">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `desktop-nav__link${isActive ? " is-active" : ""}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="user-area">
            <div className="user-chip">
              <span className="user-chip__avatar">
                {(profile?.displayName || "ط").slice(0, 1)}
              </span>
              <span className="user-chip__text">
                <strong>{profile?.displayName || "طالب"}</strong>
                <small>{branchLabel(profile?.branch)}</small>
              </span>
            </div>
            <button className="icon-button" type="button" onClick={() => void logout()} aria-label="تسجيل الخروج">
              <LogoutIcon />
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="التنقل السفلي">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `bottom-nav__link${isActive ? " is-active" : ""}`}
            >
              <Icon />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
