document.addEventListener('DOMContentLoaded', async () => {
    const mainView = document.getElementById('main-view');

    const recordBtn = document.getElementById('record-btn');
    const statusDisplay = document.getElementById('status-display');
    const notesView = document.getElementById('notes-view');

    let isRecording = false;

    // Determine state on open
    chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' }, (res) => {
        if (chrome.runtime.lastError) return;

        if (res && res.isRecording) {
            setRecordingUI(true);
        } else {
            setRecordingUI(false);
        }
    });

    const liveTranscriptEl = document.getElementById('live-transcript');

    // Render Initial Transcript from Storage
    chrome.storage.local.get(['liveTranscript', 'currentSummary'], (result) => {
        if (result.liveTranscript) {
            liveTranscriptEl.innerText = result.liveTranscript;
        }
        if (result.currentSummary) {
            renderSummary(result.currentSummary);
        }
    });

    // Listen for storage changes dynamically
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.liveTranscript) {
                liveTranscriptEl.innerText = changes.liveTranscript.newValue;
                // Auto scroll to bottom
                liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
            }
            if (changes.currentSummary) {
                renderSummary(changes.currentSummary.newValue);
            }
        }
    });

    function renderSummary(text) {
        if (!text) return;
        notesView.innerHTML = escapeHTML(text);
    }
    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    function setRecordingUI(recording) {
        isRecording = recording;
        if (recording) {
            recordBtn.innerHTML = '<span class="icon">🛑</span> Stop Notetaker';
            recordBtn.classList.add('recording');
            statusDisplay.classList.remove('hidden');
        } else {
            recordBtn.innerHTML = '<span class="icon">🎙</span> Start Notetaker';
            recordBtn.classList.remove('recording');
            statusDisplay.classList.add('hidden');
        }
    }

    recordBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!isRecording) {
            // Ask Background to start capturing audio of THIS tab
            chrome.runtime.sendMessage({
                target: 'background',
                type: 'START_CAP',
                tabId: tab.id
            });
            setRecordingUI(true);
            notesView.innerHTML = '<div class="notes-placeholder">Listening...</div>';
        } else {
            chrome.runtime.sendMessage({ target: 'background', type: 'STOP_CAP' });
            setRecordingUI(false);
        }
    });
});
