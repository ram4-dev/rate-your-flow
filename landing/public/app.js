const copyButton = document.querySelector("[data-copy-command]");
const copyFeedback = document.querySelector("[data-copy-feedback]");
const copyFallback = document.querySelector("[data-copy-fallback]");
const heroActions = document.querySelector(".hero-actions");
const installButton = document.querySelector("[data-copy-install]");
const installFeedback = document.querySelector("[data-install-feedback]");
const installCommand = "npm install -g https://github.com/ram4-dev/rate-your-flow/releases/download/v0.1.7/rate-your-flow-0.1.7.tgz";
let copyFeedbackTimer;

function clearHeroCopyStatus() {
  window.clearTimeout(copyFeedbackTimer);
  copyFeedback.textContent = "";
  copyFallback.textContent = "";
  copyFallback.hidden = true;
  heroActions.classList.remove("has-copy-fallback");
  copyButton.classList.remove("is-copied");
}

copyButton?.addEventListener("click", async () => {
  clearHeroCopyStatus();

  try {
    await navigator.clipboard.writeText(installCommand);
    copyFeedback.textContent = "Install command copied";
    copyButton.classList.add("is-copied");
    copyFeedbackTimer = window.setTimeout(clearHeroCopyStatus, 1800);
  } catch {
    copyFeedback.textContent = "Select and copy this install command:";
    copyFallback.textContent = installCommand;
    copyFallback.hidden = false;
    heroActions.classList.add("has-copy-fallback");
  }
});

installButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(installCommand);
    installFeedback.textContent = "Install command copied";
    window.setTimeout(() => { installFeedback.textContent = ""; }, 1800);
  } catch {
    installFeedback.textContent = "Select and copy the command";
  }
});
