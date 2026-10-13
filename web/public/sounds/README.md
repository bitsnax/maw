# Notification sounds

The Dashboard plays these (see "Stories" in the README):

| File | When |
|---|---|
| `stopped.wav` | a story or your own session stops for you, without an error |
| `question.wav` | you are asked something, or a step waits for your check |
| `error.wav` | a story is blocked, or your session's model fails |
| `finished.wav` | a story is done |

The `.wav` files are your own and stay out of git (`.gitignore`). The phase
scripts copy them here from `~/maw-1/sounds/`; the web image's build picks
them up from this folder. To change a sound, replace the file here and
rebuild maw-web (`docker compose up -d --build web`).
