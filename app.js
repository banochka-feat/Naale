(function () {
  const form = document.getElementById("trip-form");
  const btn = document.getElementById("submit-btn");
  const status = document.getElementById("status");

  const today = new Date().toISOString().slice(0, 10);
  form.from.min = today;
  form.to.min = today;
  form.from.addEventListener("change", () => {
    form.to.min = form.from.value || today;
  });

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function validate() {
    let ok = true;
    for (const name of ["name", "destination", "from", "to"]) {
      const el = form[name];
      const bad = !el.value.trim();
      el.classList.toggle("invalid", bad);
      if (bad) ok = false;
    }
    if (!ok) return "Заполните все обязательные поля.";
    if (form.to.value < form.from.value) {
      form.to.classList.add("invalid");
      return "Дата «по» не может быть раньше даты «с».";
    }
    return null;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = validate();
    if (error) return setStatus(error, "err");

    if (!window.FORM_ENDPOINT) {
      return setStatus("Форма ещё не настроена: не указан адрес отправки.", "err");
    }

    const data = {
      name: form.name.value.trim(),
      destination: form.destination.value.trim(),
      from: form.from.value,
      to: form.to.value,
      comment: form.comment.value.trim(),
      website: form.website.value,
    };

    btn.disabled = true;
    setStatus("Отправляем…");
    try {
      const res = await fetch(window.FORM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      form.reset();
      form.to.min = today;
      setStatus("Спасибо! Заявка отправлена.", "ok");
    } catch (err) {
      setStatus("Не удалось отправить. Попробуйте ещё раз чуть позже.", "err");
    } finally {
      btn.disabled = false;
    }
  });
})();
