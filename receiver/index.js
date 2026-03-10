const express = require('express');

const app = express();
app.use(express.json());

app.post('/*', (req, res) => {
  const targetUrl = req.originalUrl;
  console.log(`\n========= Mock Receiver Received POST =========`);
  console.log(`Target Path: ${targetUrl}`);
  console.log(`Headers:`, req.headers);
  console.log(`Body:`, req.body);
  console.log(`=============================================\n`);
  
  res.status(200).json({ status: 'ok', received: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Mock receiver running on port ${PORT}`);
});
