const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('expected #app');

root.innerHTML = `
  <h1>{{ project_name }}</h1>
  <p>{{ description or "Hello from Hex." }}</p>
`;
