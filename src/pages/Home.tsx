import { BRAND_WORDS, brandWordDuration } from '../utils/brandWords';
import { Toast } from '../components/Toast';
import { BrandMark } from "../components/BrandMark";
import { useEffect, useState } from "react";
import { generateCode, getCodeFromURL, setCodeInURL } from "../utils/roomCode";

interface HomeProps {
  onStart: (roomCode: string, isHost: boolean) => void;
}

export function Home({ onStart }: HomeProps) {
  const [wordIndex, setWordIndex] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;
    const timer = setTimeout(() => setWordIndex(index => (index + 1) % BRAND_WORDS.length), brandWordDuration(BRAND_WORDS[wordIndex]));
    return () => clearTimeout(timer);
  }, [wordIndex]);
  const prefilled = getCodeFromURL() ?? "";
  const [joinCode, setJoinCode] = useState(prefilled);
  const [joinError, setJoinError] = useState("");

  const handleStart = () => {
    const code = generateCode();
    setCodeInURL(code);
    onStart(code, true);
  };

  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setJoinError("Please enter a session code.");
      return;
    }
    setCodeInURL(code);
    onStart(code, false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo / title */}
        <div className="text-center mb-10">
          <BrandMark rounded className="mx-auto mb-5 h-16 w-16" />
          <h1 className="landing-brand brand-wordmark font-semibold text-white tracking-tight">
            <span className="sr-only">Make Together</span>
            <span aria-hidden="true" className="grid [grid-template-columns:calc(50%_-_2rem)_1fr] items-baseline">
              <span className="brand-words text-brand-300">
                <span className="brand-word-sizer">collaborate</span>
                <span key={wordIndex} className="brand-word">{BRAND_WORDS[wordIndex]}</span>
              </span>
              <span className="text-left">together</span>
            </span>
          </h1>
          <p className="text-zinc-400 mt-2 text-sm">
            Video chat, share a canvas and create together. No login required.
          </p>
        </div>

        <div className="space-y-4">
          {/* Start Session */}
          <button
            onClick={handleStart}
            className="w-full bg-brand-600 hover:bg-brand-500 active:bg-brand-700 text-white font-semibold py-3.5 px-5 rounded-2xl transition-colors shadow-lg shadow-brand-900/40 text-sm"
          >
            Start Session
          </button>

          <div className="flex items-center gap-3 text-zinc-600 text-xs">
            <div className="flex-1 h-px bg-zinc-800" />
            or join an existing one
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          {/* Join Session */}
          <div className="space-y-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value.toUpperCase());
                setJoinError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              placeholder="Enter session code"
              className={`w-full bg-zinc-900 border ${
                joinError
                  ? "border-red-500"
                  : "border-zinc-700 focus:border-brand-500"
              } text-white font-mono placeholder:text-zinc-600 text-sm rounded-xl px-4 py-3 outline-none transition-colors`}
              spellCheck={false}
              autoCapitalize="characters"
            />
            <Toast message={joinError} label="Session code error" onDismiss={() => setJoinError('')} />
            <button
              onClick={handleJoin}
              className="w-full bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-200 font-semibold py-3.5 px-5 rounded-2xl transition-colors text-sm"
            >
              Join Session
            </button>
          </div>
        </div>

        <p className="text-zinc-700 text-xs text-center mt-8">
          Sessions are peer-to-peer. No data leaves your browser.
        </p>
      </div>
    </div>
  );
}
