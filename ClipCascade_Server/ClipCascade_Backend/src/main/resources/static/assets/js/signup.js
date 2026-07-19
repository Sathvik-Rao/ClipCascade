
      // Function to refresh the captcha image
      function refreshCaptcha() {
        const captchaInput = document.getElementById("captchaInput");
        const captchaImage = document.getElementById("captchaImage");
        captchaInput.value = "";
        captchaImage.src = "/captcha?" + new Date().getTime(); // Adding timestamp to avoid caching
      }

      document.addEventListener("DOMContentLoaded", function () {
        const signupForm = document.getElementById("signupForm");
        const passwordField = document.getElementById("password");
        const confirmPasswordField = document.getElementById("confirmPassword");
        const captchaInput = document.getElementById("captchaInput");
        const captchaImage = document.getElementById("captchaImage");
        const errorDiv = document.getElementById("errorDiv");

        // Handle form submission using AJAX
        signupForm.addEventListener("submit", function (event) {
          event.preventDefault();

          // Check if passwords match
          if (passwordField.value !== confirmPasswordField.value) {
            alert("Passwords do not match!");
            return;
          }

          const formData = new FormData(signupForm);
          formData.set("password", sha3_512(passwordField.value)); // hash the password
          formData.delete("confirmPassword"); // Remove the confirm password field

          fetch(signupForm.action, {
            method: "POST",
            body: formData,
          })
            .then((response) => {
              if (response.ok) {
                //success
                window.location.href = "/login?registered";
              } else {
                //failure
                response.text().then((text) => {
                  if (text.toLowerCase().includes("captcha")) {
                    // invalid captcha
                    refreshCaptcha(); // Refresh the captcha
                    alert("Captcha is invalid. Please try again.");
                  } else {
                    // registration error
                    if (text.trim() !== "") {
                      errorDiv.textContent = text;
                    }
                    errorDiv.style.display = "block";
                    refreshCaptcha(); // Refresh the captcha
                  }
                });
              }
            })
            .catch((error) => {
              console.error("Error:", error);
              alert(
                "There was an error with the registration process. Please try again."
              );
            });
        });
      });
    
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('refresh-captcha-btn');
  if (btn && typeof refreshCaptcha === 'function') {
    btn.addEventListener('click', refreshCaptcha);
  }
});
