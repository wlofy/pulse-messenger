import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { runSelfTest } from './vision.js'
import './styles.css'

// The scene-reasoning engine is pure — boxes in, sentences out — so it can be
// checked with no model, no network and no test runner. Open the app with
// ?selftest and read the console. (Importing vision.js here costs nothing: the
// composer already pulls it in. The heavy part, tfjs, is behind a dynamic
// import *inside* it and only downloads when a photo is actually handled.)
if (location.search.includes('selftest')) runSelfTest()

createRoot(document.getElementById('root')).render(<App />)
