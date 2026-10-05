import { useLayoutEffect } from 'react';

/** Keep local controls inside the visible viewport when Safari pans for a keyboard. */
export function useVisibleViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      // Preserve normal browser pinch zoom; only follow keyboard/browser chrome.
      if (viewport && viewport.scale !== 1) return;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const values = { left, top, width, height,
        right: Math.max(0, window.innerWidth - left - width),
        bottom: Math.max(0, window.innerHeight - top - height) };
      for (const [key, value] of Object.entries(values)) root.style.setProperty('--visible-' + key, value + 'px');
    };
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      for (const key of ['left', 'top', 'width', 'height', 'right', 'bottom']) root.style.removeProperty('--visible-' + key);
    };
  }, []);
}
