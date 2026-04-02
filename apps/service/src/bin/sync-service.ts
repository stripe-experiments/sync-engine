#!/usr/bin/env node
import 'dotenv/config'
import { runMain } from 'citty'
import { createProgram } from '../cli/cli.js'

const program = await createProgram()
runMain(program)
