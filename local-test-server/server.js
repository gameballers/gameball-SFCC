const http = require('http');

const PORT = 3000;

const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', () => {
        console.log('\n--- NEW REQUEST RECEIVED ---');
        console.log(`Method: ${req.method}`);
        console.log(`URL: ${req.url}`);
        console.log('Headers:');
        console.log(req.headers);
        
        console.log('\nBody:');
        if (body) {
            try {
                // Try to pretty-print if it's JSON
                console.log(JSON.stringify(JSON.parse(body), null, 2));
            } catch (e) {
                console.log(body);
            }
        } else {
            console.log('(empty body)');
        }
        console.log('----------------------------\n');

        // Respond with 200 OK
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'Payload received by local test server' }));
    });
});

server.listen(PORT, () => {
    console.log(`Local Test Server is listening on http://localhost:${PORT}`);
    console.log(`Run ngrok with: ngrok http ${PORT}`);
});
