document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("debugSurveyBtn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    // Fake values just for testing
    const meetingCode = "TEST123";
    const respondentId = `debug-${Math.random().toString(16).slice(2)}`;
    const role = "join";

    // If your survey page reads these params, this will populate context.
    // If it doesn’t, it still safely opens the survey page.
    const url = `/survey.html?code=${encodeURIComponent(meetingCode)}&clientId=${encodeURIComponent(
      respondentId
    )}&role=${encodeURIComponent(role)}`;

    window.location.href = url;
  });
});
