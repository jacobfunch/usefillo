import {
  createClient,
  createFormElement,
  defineForm,
  registerFilloElement,
  renderForm,
  FilloClient,
  FilloError,
} from "./index.js";

// Guarded so importing/evaluating the bundle in a non-browser env (SSR, tests)
// is a no-op rather than a crash; registerFilloElement itself also guards.
if (typeof customElements !== "undefined") registerFilloElement();

export {
  createClient,
  createFormElement,
  defineForm,
  registerFilloElement,
  renderForm,
  FilloClient,
  FilloError,
};
