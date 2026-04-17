// Service worker logic for orchestrating recording and summarization

let recordingState = false;
let transcriptBuffer = "";
let lastSummaryTime = 0;
const SUMMARY_INTERVAL = 10000; // Generate summary every 10 seconds of audio

// HARDCODED API KEY: Replace with your actual Groq API key so users don't need to provide it
const BUILT_IN_API_KEY = "gsk_your_api_key_here";
let apiKey = BUILT_IN_API_KEY;

let currentRecordingTabId = null; // Track the tab being recorded
let pulseInterval = null;
let isDotVisible = false;

function startPulse() {
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    pulseInterval = setInterval(() => {
        isDotVisible = !isDotVisible;
        chrome.action.setBadgeText({ text: isDotVisible ? '●' : '' });
    }, 800);
}

function stopPulse() {
    if (pulseInterval) clearInterval(pulseInterval);
    chrome.action.setBadgeText({ text: '' });
}

async function setupOffscreenDocument(streamId) {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(
        (c) => c.contextType === 'OFFSCREEN_DOCUMENT'
    );

    // Create offscreen document if it doesn't exist
    if (!offscreenDocument) {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Recording tab audio for AI transcription'
        });
    }

    // Pass the stream ID and API key to the offscreen document
    chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        target: 'offscreen',
        data: streamId,
        apiKey: apiKey
    });
}

async function stopOffscreenDocument() {
    // Tell offscreen doc to stop
    chrome.runtime.sendMessage({
        type: 'STOP_RECORDING',
        target: 'offscreen'
    });

    // Slight delay to allow final chunk to upload
    setTimeout(async () => {
        try {
            await chrome.offscreen.closeDocument();
        } catch (e) {
            console.log("Error closing offscreen: ", e);
        }
    }, 2000);
}

// Ensure popup can ask for current state
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === 'background') {
        if (msg.type === 'GET_STATE') {
            sendResponse({ isRecording: recordingState, transcript: transcriptBuffer });
        } else if (msg.type === 'START_CAP') {
            startCapture(msg.tabId);
            sendResponse({ success: true });
        } else if (msg.type === 'STOP_CAP') {
            stopCapture();
            sendResponse({ success: true });
        } else if (msg.type === 'NEW_TRANSCRIPT_CHUNK') {
            // Received transcription from offscreen doc
            transcriptBuffer += " " + msg.text;

            chrome.storage.local.set({ liveTranscript: transcriptBuffer.trim() });

            // Generate summary if it's been long enough
            const now = Date.now();
            if (now - lastSummaryTime > 10000 && transcriptBuffer.trim().length > 10) {
                lastSummaryTime = now;
                generateSummary(transcriptBuffer);
            }
        }
    }
});

// Listen for YouTube SPA navigation (URL change on ANY tab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // If the URL changes and the user is on YouTube
    if (changeInfo.url && changeInfo.url.includes("youtube.com")) {
        console.log("Detected YouTube video switch. Flushing storage buffers.");

        // Aggressively clear the storage data unconditionally on any new video
        chrome.storage.local.set({
            liveTranscript: "",
            currentSummary: ""
        });

        // If we were actively recording this tab, shut down the capture engine
        if (recordingState && currentRecordingTabId === tabId) {
            recordingState = false;
            currentRecordingTabId = null;
            transcriptBuffer = "";
            stopPulse();
            stopOffscreenDocument();
        }
    }
});

function startCapture(tabId) {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (!streamId) {
            console.error("No stream ID retrieved");
            chrome.storage.local.set({ liveTranscript: "\n(Error: Stream ID failed. Please refresh the YouTube tab.)" });
            return;
        }
        recordingState = true;
        currentRecordingTabId = tabId; // Track tab explicitly
        transcriptBuffer = ""; // Reset internal buffer
        lastSummaryTime = Date.now();

        // Reset storage with a successful connection message
        chrome.storage.local.set({
            liveTranscript: "Listening to tab audio...",
            currentSummary: ""
        });

        startPulse();
        setupOffscreenDocument(streamId);
    });
}

function stopCapture() {
    recordingState = false;
    currentRecordingTabId = null;
    stopPulse();
    stopOffscreenDocument();

    const wordCount = transcriptBuffer.trim().split(/\s+/).length;
    if (wordCount < 10) {
        chrome.storage.local.set({
            currentSummary: "Not enough content to summarize. Please ensure the transcript contains meaningful speech.",
            lastUpdated: Date.now()
        });
    } else {
        generateFinalSummary(transcriptBuffer);
    }
}

// stopCaptureAndReset is no longer explicitly needed because the new aggressive tabs.onUpdated listener handles it seamlessly!

async function generateSummary(text) {
    if (!apiKey) {
        console.error("Missing API Key");
        return;
    }

    const systemPrompt = `You are an automated Sermon Notetaker. 
Analyze the following raw transcript of a sermon and extract structured notes.
Do NOT use markdown headings (#). Use bullet points.
Extract the following:
📖 Scripture References:
✝️ Key Theological Points:
🔄 Themes:
✅ Actionable Application:

If there's not enough data for a category yet, just write "Gathering information...".
Keep it very concise.`;

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: text }
                ],
                temperature: 0.3
            })
        });

        if (response.ok) {
            const data = await response.json();
            const summary = data.choices[0].message.content;

            chrome.storage.local.set({
                currentSummary: summary,
                lastUpdated: Date.now()
            });
        }
    } catch (err) {
        console.error("Error generating summary:", err);
    }
}

async function generateFinalSummary(text) {
    if (!apiKey) return;

    const systemPrompt = `You are an AI Note-taker. Process the complete live transcript text of the following sermon/conversation and generate a full, structured final summary.
Language: Professional, neutral, and easy to scan. Limit to 1 paragraph per 5 minutes of conversation, plus lists.
You MUST format exactly matching the structure below. Use bullet points or numbered lists where appropriate:

Meeting / Conversation Summary

Topic (If mentioned during the sermon)

Scriptures of the Bible
[Scripture 1]
[Scripture 2]

Examples (If shared)
[Example 1]
[Example 2]

Prayer Points (If mentioned)
[Prayer Points 1]
[Prayer Points 2]

Key Points:
[Point 1]
[Point 2]

Action Items:
[Who] to [task] by [timeframe if mentioned]

Decisions Made:
[Decision 1]

Open Questions:
[Question 1]`;

    try {
        // We set the summary box to "Generating final summary..." immediately
        chrome.storage.local.set({
            currentSummary: "Generating final summary based on complete transcript... Please wait.",
            lastUpdated: Date.now()
        });

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile", // Upgraded to 128k context window to prevent token overflow on long sermons
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: text }
                ],
                temperature: 0.2 // Set low for highly structured JSON/markdown adherence
            })
        });

        if (response.ok) {
            const data = await response.json();
            const summary = data.choices[0].message.content;

            chrome.storage.local.set({
                currentSummary: summary,
                lastUpdated: Date.now()
            });
        } else {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error?.message || response.statusText;
            chrome.storage.local.set({
                currentSummary: `Error finalizing summary. API rejected request (${response.status}): ${errMsg}`
            });
            console.error("API Error details:", errData);
        }
    } catch (err) {
        chrome.storage.local.set({
            currentSummary: "Network error finalizing summary."
        });
        console.error("Error finalizing summary:", err);
    }
}
