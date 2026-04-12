let recorder = null;
let stream = null;
let apiKey = "";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') {
        if (message.type === 'START_RECORDING') {
            apiKey = message.apiKey;
            startRecording(message.data);
            sendResponse({ started: true });
        } else if (message.type === 'STOP_RECORDING') {
            stopRecording();
            sendResponse({ stopped: true });
        }
    }
});

async function startRecording(streamId) {
    if (recorder && recorder.state === 'recording') return;

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        });

        // 🚨 CRITICAL FIX: TabCapture natively mutes the browser tab by default!
        // We must re-route the captured stream back into an AudioContext to play out loud 
        // to the user's physical speakers so they can still hear the YouTube video!
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(audioCtx.destination);

        // Use webm audio natively captured by Chrome
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        recorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && apiKey) {
                transcribeChunk(event.data);
            }
        };

        // Explicitly restart the recorder every 5 seconds
        // This ensures every chunk has a valid WebM header for the API!
        recorder.start();
        setInterval(() => {
            if (recorder.state === 'recording') {
                recorder.stop();
                recorder.start();
            }
        }, 5000);

    } catch (err) {
        chrome.runtime.sendMessage({
            target: 'background',
            type: 'NEW_TRANSCRIPT_CHUNK',
            text: `\n(Failed to bind to mic/tab: ${err.message})`
        });
        console.error("Microphone capture failed:", err);
    }
}

function stopRecording() {
    if (recorder && recorder.state === 'recording') {
        recorder.stop();
        stream.getTracks().forEach(t => t.stop());
    }
}

async function transcribeChunk(audioBlob) {
    // Generate a quick file representation
    const file = new File([audioBlob], "chunk.webm", { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-large-v3");
    formData.append("language", "en");

    try {
        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + apiKey
            },
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            if (data.text && data.text.trim()) {
                // Forward transcription to Background controller
                chrome.runtime.sendMessage({
                    target: 'background',
                    type: 'NEW_TRANSCRIPT_CHUNK',
                    text: data.text.trim()
                });
            } else {
                // If Whisper successfully processed an empty chunk, send a small indicator
                chrome.runtime.sendMessage({
                    target: 'background',
                    type: 'NEW_TRANSCRIPT_CHUNK',
                    text: ' . '
                });
            }
        } else {
            const errData = await response.json();
            chrome.runtime.sendMessage({
                target: 'background',
                type: 'NEW_TRANSCRIPT_CHUNK',
                text: `\n(API Error ${response.status}: ${errData.error?.message || response.statusText})`
            });
            console.error("Whisper API Error:", response.status, response.statusText);
        }
    } catch (e) {
        chrome.runtime.sendMessage({
            target: 'background',
            type: 'NEW_TRANSCRIPT_CHUNK',
            text: `\n(Network Error: ${e.message})`
        });
        console.error("Transcription failed", e);
    }
}
