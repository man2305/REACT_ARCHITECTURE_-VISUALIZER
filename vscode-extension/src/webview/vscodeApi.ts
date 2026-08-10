export type VscodeApi = {
  postMessage: (message: unknown) => void;
};

const bridge = typeof window === "undefined" ? undefined : window;

export const vscodeApi: VscodeApi | undefined = (
  bridge as { acquireVsCodeApi?: () => VscodeApi } | undefined
)?.acquireVsCodeApi?.();
