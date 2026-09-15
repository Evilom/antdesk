import React from 'react';
import {createRoot} from 'react-dom/client';
import PetDialogue from './components/PetDialogue';
import './dialogue.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><PetDialogue/></React.StrictMode>);
