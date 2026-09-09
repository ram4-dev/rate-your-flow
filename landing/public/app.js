const copyButton = document.querySelector("[data-copy-command]");
const copyFeedback = document.querySelector("[data-copy-feedback]");
const installButton = document.querySelector("[data-copy-install]");
const installFeedback = document.querySelector("[data-install-feedback]");
const installCommand = "npm install -g https://github.com/ram4-dev/rate-your-flow/releases/download/v0.1.7/rate-your-flow-0.1.7.tgz";

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("ryf");
    copyFeedback.textContent = "Command copied";
    copyButton.classList.add("is-copied");
    window.setTimeout(() => {
      copyFeedback.textContent = "";
      copyButton.classList.remove("is-copied");
    }, 1800);
  } catch {
    copyFeedback.textContent = "Copy ryf";
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
