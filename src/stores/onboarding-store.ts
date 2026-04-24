import { create } from "zustand";
import { persist } from "zustand/middleware";

interface OnboardingState {
  dismissedTips: string[];
  tourCompleted: boolean;
  chatSeen: boolean;
  wizardPending: boolean;
  wizardDismissed: boolean;
  dismissTip: (id: string) => void;
  setTourCompleted: () => void;
  setChatSeen: () => void;
  setWizardPending: () => void;
  setWizardDismissed: () => void;
  isTipDismissed: (id: string) => boolean;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      dismissedTips: [],
      tourCompleted: false,
      chatSeen: false,
      wizardPending: false,
      wizardDismissed: false,
      dismissTip: (id) =>
        set((state) => ({
          dismissedTips: [...state.dismissedTips, id],
        })),
      setTourCompleted: () => set({ tourCompleted: true }),
      setChatSeen: () => set({ chatSeen: true }),
      setWizardPending: () => set({ wizardPending: true }),
      setWizardDismissed: () => set({ wizardPending: false, wizardDismissed: true }),
      isTipDismissed: (id) => get().dismissedTips.includes(id),
    }),
    { name: "quanttrader-onboarding" }
  )
);
