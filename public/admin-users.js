document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.delete-form').forEach(form => {
    form.addEventListener('submit', (e) => {
      const email = form.dataset.email || '';

      const ok = confirm(`Delete user "${email}"? This cannot be undone.`);
      if (!ok) { e.preventDefault(); return; }

      const typed = prompt(`Type the user's email to confirm deletion:\n${email}`);
      if (!typed) { e.preventDefault(); return; }

      if (typed.trim().toLowerCase() !== email.trim().toLowerCase()) {
        alert('Email does not match. Deletion cancelled.');
        e.preventDefault();
        return;
      }

      const hidden = form.querySelector('input[name="confirmEmail"]');
      if (hidden) hidden.value = typed.trim();
    });
  });
});