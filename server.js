import { createApp } from './src/app.js';

// Process entrypoint that boots the modular Express app.
const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
