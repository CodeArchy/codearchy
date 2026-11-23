import { util } from '@app/lib/util';
import { Button } from './ui/Button';
import { shared } from '@poly/shared';
import esm from './esm.js';
import React from 'react';
export const app = () => [util, Button, shared, esm, React];
