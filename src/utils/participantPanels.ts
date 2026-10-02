import type { PanelState } from '../types/panels';

/** Translate shared AV geometry from the snapshot sender to the joining client. */
export function participantPanelsForReceiver(
  fixedPanels: Record<'local' | 'remote', PanelState>,
  remotePanels: Record<string, PanelState> | undefined,
  sourcePeerId: string,
  localPeerId: string,
) {
  const peers = { ...remotePanels, [sourcePeerId]: { ...fixedPanels.local } };
  const local = peers[localPeerId] ?? fixedPanels.remote;
  delete peers[localPeerId];
  return {
    fixedPanels: { local: { ...local }, remote: { ...fixedPanels.remote } },
    remotePanels: peers,
  };
}
