# Murmur

## MANDATORY: Voice Conversation Parameters

When using the VoiceMode converse tool for standby listening (empty message, skip_tts=true):

**NEVER pass `disable_silence_detection`.**
**ALWAYS use `listen_duration_max: 60`, `listen_duration_min: 1.5`, `vad_aggressiveness: 2`.**

Silence detection must stay enabled so recording stops when the user finishes speaking.
Using disable_silence_detection causes a 30-second freeze which is unacceptable.
