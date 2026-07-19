document.addEventListener("DOMContentLoaded", function () {
  const loginForm = document.getElementById("loginForm");
  const passwordField = document.getElementById("password");
  if (!loginForm || !passwordField || typeof sha3_512 !== "function") {
    return;
  }

  loginForm.addEventListener("submit", function () {
    const rawPassword = passwordField.value;
    passwordField.value = sha3_512(rawPassword);
  });
});
