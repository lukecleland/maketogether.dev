import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * SummonButton — pull someone into this room through whatever app you'd
 * normally message them in.
 *
 * ## Two ways in, chosen by device rather than by API support
 * On a phone, `navigator.share()` opens the device's own share sheet, which
 * lists every messaging app installed and already knows the user's contacts.
 * One call covers WhatsApp, Messages, Mail, Signal and the rest, with nothing
 * to keep up to date as people change apps.
 *
 * Everywhere else we show our own centred modal. Note that this is *not* simply a
 * fallback for browsers lacking the API: desktop Safari supports
 * `navigator.share` perfectly well, but the sheet it opens is Notes, Freeform,
 * Journal and Reminders — places to file a link rather than people to send it
 * to. Offering Message, WhatsApp and Email directly is better there, so the
 * choice keys off `pointer: coarse`, not off feature detection.
 *
 * ## No "who's calling" field
 * The invite travels from the sender's own WhatsApp or Messages account, so
 * the channel already says who it's from. A name field here would be asking
 * for something the recipient can already see.
 *
 * ## The room is a doorbell, not a calendar invite
 * A room only exists while someone is in it — the code is a live PeerJS peer
 * id, not a record on a server. So the wording is "join now" rather than
 * anything that implies the link keeps working tomorrow.
 */

interface SummonButtonProps {
  roomCode: string;
}

const INVITE_TEXT = "Join my Make Together room:";

/**
 * iOS and Android disagree on `sms:` parameter syntax — iOS wants `&body=`
 * after the (empty) recipient, Android wants `?body=`. Getting this wrong
 * opens the messaging app with an empty message, which looks like the feature
 * simply doesn't work.
 */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, distinguishable only by touch support
  return /iP(hone|ad|od)/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Whether the device's own share sheet is worth deferring to.
 *
 * On a phone it is a list of *people* — WhatsApp, Messages, recent contacts —
 * and beats anything we could offer. On desktop macOS the same API returns a
 * list of *places to file a link*: Notes, Reminders, Freeform, Journal. None
 * of those summon anybody, and they crowd out the three that do.
 *
 * `pointer: coarse` means touch is the primary input, which is the closest
 * thing to "this is a phone" that doesn't involve sniffing user agents.
 */
function prefersNativeSheet(): boolean {
  return (
    typeof navigator.share === "function" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

export function SummonButton({ roomCode }: SummonButtonProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Escape closes the dialog. Move focus into it on open and return focus to
  // the Summon button on close so keyboard users never lose their place.
  useEffect(() => {
    if (!modalOpen) return;
    const trigger = buttonRef.current;
    modalRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModalOpen(false);
        return;
      }
      if (e.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, [modalOpen]);

  // Built fresh each time rather than read from window.location, so the room
  // parameter is right even if something else has touched the URL.
  const inviteUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  };

  const handleSummon = () => {
    const url = inviteUrl();

    // `navigator.share` has to be called synchronously inside the click
    // handler — awaiting anything first loses the user gesture and Safari
    // silently refuses to open the sheet.
    if (prefersNativeSheet()) {
      navigator
        .share({ title: "Make Together", text: INVITE_TEXT, url })
        .catch(() => {
          // Cancelling the sheet rejects too; there is nothing to report
        });
      return;
    }
    setModalOpen(true);
  };

  const copyLink = () => {
    const url = inviteUrl();
    navigator.clipboard.writeText(url).catch(() => {
      // Clipboard can be blocked; the code stays readable on the button
    });
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  const shareLinks = () => {
    const url = inviteUrl();
    const message = `${INVITE_TEXT} ${url}`;
    return [
      {
        key: "sms",
        label: "Message",
        href: `sms:${isIOS() ? "&" : "?"}body=${encodeURIComponent(message)}`,
      },
      {
        key: "whatsapp",
        label: "WhatsApp",
        // wa.me with no number opens a contact picker in the app or web client
        href: `https://wa.me/?text=${encodeURIComponent(message)}`,
      },
      {
        key: "email",
        label: "Email",
        href: `mailto:?subject=${encodeURIComponent(
          "Join my Make Together room",
        )}&body=${encodeURIComponent(message)}`,
      },
    ];
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        data-summon-variant="bar"
        onClick={handleSummon}
        className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-mono px-2 sm:px-3 py-1.5 rounded-lg transition-colors"
        title={`Summon someone to room ${roomCode}`}
        aria-label={`Summon someone to room ${roomCode}`}
        aria-haspopup={prefersNativeSheet() ? undefined : "dialog"}
        aria-expanded={prefersNativeSheet() ? undefined : modalOpen}
      >
        <span className="hidden sm:inline">{roomCode}</span>
        {/* Outward arrow — the same gesture every platform uses for "send this
            somewhere else", so it reads before the label does. */}
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4v12M12 4L8 8m4-4l4 4M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4"
          />
        </svg>
        <span className="hidden sm:inline">
          Summon
        </span>
      </button>

      {modalOpen && createPortal(
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          onMouseDown={e => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div>
                <h2 id={titleId} className="text-sm font-semibold text-zinc-100">Summon a friend</h2>
                <p className="mt-0.5 text-xs text-zinc-500">Invite someone to room <span className="font-mono text-zinc-400">{roomCode}</span></p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                aria-label="Close invite dialog"
                className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-white"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="grid gap-2 p-4">
              {shareLinks().map((link, index) => (
                <a
                  key={link.key}
                  data-autofocus={index === 0 ? "true" : undefined}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setModalOpen(false)}
                  className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-brand-500 hover:bg-zinc-700"
                >
                  {link.label}
                </a>
              ))}
              <button
                onClick={copyLink}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-left text-sm font-medium text-zinc-200 transition-colors hover:border-brand-500 hover:bg-zinc-700"
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
