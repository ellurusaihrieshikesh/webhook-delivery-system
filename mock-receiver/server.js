const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory array to store recent events for the GUI
const receivedEvents = [];

app.post('/events', (req, res) => {
  const event = {
    timestamp: new Date().toISOString(),
    headers: req.headers,
    body: req.body
  };
  
  // Add to beginning of array
  receivedEvents.unshift(event);
  
  // Keep only the last 50 events to prevent memory leaks in the mock receiver
  if (receivedEvents.length > 50) {
    receivedEvents.pop();
  }

  console.log('Received Mock Webhook Event at', event.timestamp);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('----------------------------------------------------');
  
  res.status(200).send('OK');
});

// Provides the events to our browser GUI
app.get('/api/events', (req, res) => {
  res.status(200).json(receivedEvents);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Mock Receiver running on port ${PORT}`);
});
