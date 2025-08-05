'use strict';
(function (ff) {



const dom = ff.dom
const isArray = Array.isArray
const toString = Object.prototype.toString



const util = {

	toCamerCase (str) {
		return str.replace(/-[a-z]/g, m0 => m0[1].toUpperCase())
	},


	isInt (num) {
		return parseInt(num) === num
	},


	isArray (obj) {
		return obj && isArray(obj)
	},


	isObject (obj) {
		return obj && typeof obj === 'object'
	},


	isEmptyObject (obj) {
		for (let key in obj) {
			return false
		}

		return true
	},


	isNullOrUndefined (value) {
		return value === null || value === undefined
	},


	// getPropertyDescriptor (obj, name) {
	// 	let proto = obj

	// 	do {
	// 		let descriptor = Object.getOwnPropertyDescriptor(proto, name)
	// 		if (descriptor) {
	// 			return descriptor
	// 		}
	// 		else {
	// 			proto = proto.__proto__
	// 		}
	// 	}
	// 	while (proto)

	// 	return null
	// },
}



ff.assign(ff, {

	//to compile a?.b -> function () { return ff.safeProperty(this.a, 'b') }
	safeProperty (obj, keys, restFn) {
		let value = obj

		if (value === null || value === undefined) {
			return undefined
		}

		for (let key of keys) {
			value = value[key]

			if (value === null || value === undefined) {
				return undefined
			}
		}

		if (restFn) {
			return restFn(value)
		}
		else {
			return value
		}
	},

	//to compile a?.b = ... -> function () { return ff.safeAssign(this.a, 'b', ...) }
	safeAssign (obj, keys, assignedValue) {
		let lastKey = keys.pop()
		let value = ff.safeProperty(obj, keys)

		if (value !== null) {
			value[lastKey] = assignedValue
		}
		
		return assignedValue
	},

	//to compile a?.b(...) -> function () { return ff.safeCall(this.a, 'b', ...) }
	safeCall (obj, keys, args, restFn) {
		let lastKey = keys.pop()
		let value = ff.safeProperty(obj, keys)

		if (value == null || typeof value[lastKey] !== 'function') {
			return undefined
		}
		else {
			value = value[lastKey](...args)
			
			if (restFn) {
				return restFn(value)
			}
			else {
				return value
			}
		}
	},
})



const VALUE            = 0
const VARIABLE         = 1
const OPERATOR         = 2
const PROPERTY         = 3
const KEYWORD_VALUE    = 4
const KEYWORD_FUNCTION = 5
const KEYWORD_OPERATOR = 6
const OBJ_START        = 7
const OBJ_END          = 8
const OBJ_KEY          = 9
const OBJ_COLON        = 10
const OBJ_COMMA        = 11
const BRACKET_START    = 12
const BRACKET_END      = 13

//compile a + b -> function () {this.a + this.b}
const lexer = {

	EXPRESSION_REGEXP: /('(?:\\'|[^'])*?'|"(?:\\"|[^"])*?"|(?:0x\d+|\d*\.\d+|\d+)(?:e\d+)?)|(`(?:\\`|[^`])*?`)|([a-z_$][\w$]*)|(;|[.+\-~!*\/%<>=&^|?:,]+)|([\[\](){}])/gi,

	TEMPLATE_REGEXP: /\$\{(.+?)\}/g,

	FILTER_REGEXP: /\|\s*([\w-]+)(?:((?:\|\||[^|])+))?/g,

	FILTER_FN_REGEXP: /^\(.+?\)$/,

	//{{{a}}} -> {a: this.a}
	DELIMITER_REGEXP: /\{\{([\s\S]+?)\}\}(?!\})/g,

	FOR_LOOP_REGEXP: /^(.+?)\s+(in|of)\s+(.+)$/,

	FOR_IN_LOOP_REGEXP: /^\s*(\w+)?(?:\s*,\s*(.+?))?(?:\s*,\s*(\w+))?\s*$/,

	FOR_OF_LOOP_REGEXP: /^\s*(.+?)?(?:\s*,\s*(\w+))?\s*$/,

	FOR_TO_LOOP_REGEXP: /^(\w+)\s*=\s*(.+?)\s+to\s+(.+?)(?:\s+step\s+(.+))?$/,

	//keywords can be function name, but cant to be the first property name
	KEYWORD_VALUE: ff.index([
		'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
		'arguments', 'this', 'debugger', 'function',
		'ff'
	]),

	//keywords can be function name, but cant to be the first property name
	KEYWORD_FUNCTION: ff.index([
		'Object', 'Array' , 'Boolean', 'isFinite', 'isNaN', 'JSON',  'Math', 'Number', 'String','parseFloat', 'parseInt',
	]),

	UNARY_KEYWORD_OPERATOR: ff.index([
		'delete', 'new', 'typeof', 'void',
	]),

	BINARY_KEYWORD_OPERATOR: ff.index([
		'in', 'instanceof'
	]),


	readerCache: {},
	writterCache: {},
	handlerCache: {},
	delimiterCache: {},
	loopCache: {},


	isSingleVariable (exp) {
		return /^\s*\w+\s*$/.test(exp)
	},


	//a, a.b or a[b], no operator or bracket
	isEntireProperty (exp) {
		return !/[+\-~!*\/%<>=&^|:\(\)\{\}]/.test(exp)
	},


	isDelimiterExpression (exp) {
		let re = lexer.DELIMITER_REGEXP
		re.lastIndex = 0

		return re.test(exp)
	},


	toStringCode (str) {
		return "'" + str.replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n') + "'"
	},


	bindScope (exp, args = []) {
		let {types, tokens, filterIndex, lastExpressionIndex, hasSafeGetter} = lexer.parseToTokens(exp, args)

		this.addScopeToTokens(types, tokens)

		if (hasSafeGetter) {
			this.addSafeGetterToTokens(types, tokens)
		}

		let filters = null
		if (filterIndex > 0) {
			filters = lexer.parseFilters(exp, filterIndex)
		}
		
		let previousCode = tokens.slice(0, lastExpressionIndex).join('')
		let returnedCode = tokens.slice(lastExpressionIndex).join('')

		return {
			previousCode,
			returnedCode,
			filters,
		}
	},


	parseToTokens (exp, args = []) {
		let re = lexer.EXPRESSION_REGEXP
		re.lastIndex = 0

		let objectDeep = 0
		let expect = VALUE
		let tokens = []
		let types = []
		let lastType = OPERATOR
		let filterIndex = -1
		let lastExpressionIndex = 0
		let hasSafeGetter = false

		while (true) {
			let m = re.exec(exp)
			if (!m) {
				break
			}

			let [m0, m1, m2, m3, m4, m5] = m
			let type

			//string or number, no change
			if (m1) {
				tokens.push(m1)
				type = VALUE
				expect = OPERATOR
			}

			//`template`
			else if (m2) {
				let lastIndex = re.lastIndex
				tokens.push(this.bindScopeToTemplateString(m2))
				re.lastIndex = lastIndex
				
				type = VALUE
				expect = OPERATOR
			}

			//property
			else if (m3) {
				if (expect === PROPERTY) {
					type = expect
					expect = OPERATOR
					tokens.push(m3)
				} 
				else if (expect === OBJ_KEY) {
					type = OBJ_KEY
					expect = OBJ_COLON
					tokens.push(m3)
				}
				else if (lexer.KEYWORD_VALUE[m3] || args.includes(m3)) {
					type = KEYWORD_VALUE
					expect = OPERATOR
					tokens.push(m3)
				}
				else if (lexer.UNARY_KEYWORD_OPERATOR[m3]) {
					type = KEYWORD_OPERATOR
					expect = OPERATOR
					tokens.push(m3 + ' ')
				}
				else if (lexer.BINARY_KEYWORD_OPERATOR[m3]) {
					type = KEYWORD_OPERATOR
					expect = OPERATOR
					tokens.push(' ' + m3 + ' ')
				}
				else if (lexer.KEYWORD_FUNCTION[m3]) {
					type = KEYWORD_FUNCTION
					expect = OPERATOR
					tokens.push(m3)
				}
				else {
					type = VARIABLE
					expect = OPERATOR
					tokens.push(m3)
				}
			}

			//operators
			else if (m4) {
				if (m4 === '|') {
					filterIndex = re.lastIndex - 1
					break
				}

				switch (m4) {
					case ',':
						if (expect === OBJ_COLON) {
							let index = tokens.length - 1
							tokens.push(':')
							tokens.push(tokens[index])
							types.push(OBJ_COLON)
							types.push(VARIABLE)
						}

						if (objectDeep > 0) {
							expect = OBJ_KEY
						}
						else {
							expect = VALUE
						}
						break

					case '?.':
						hasSafeGetter = true

					case '.':
						expect = PROPERTY
						break

					case ';':
						lastExpressionIndex = tokens.length + 1

					default:
						expect = VALUE
				}

				type = OPERATOR
				tokens.push(m4)
			}

			else {
				switch (m5) {
					case '(':
						if (lastType === KEYWORD_VALUE || lastType === KEYWORD_OPERATOR) {
							types[types.length - 1] = VARIABLE
						}

						type = BRACKET_START
						expect = VALUE
						break

					case '[':
						type = BRACKET_START
						expect = VALUE
						break

					case '{':
						objectDeep++
						type = OBJ_START
						expect = OBJ_KEY
						break

					case '}':
						if (expect === OBJ_COLON) {
							let index = tokens.length - 1
							tokens.push(':')
							tokens.push(tokens[index])
							types.push(OBJ_COLON)
							types.push(VARIABLE)
						}

						type = OBJ_END

						if (--objectDeep > 0) {
							expect = OBJ_COMMA
						}
						else {
							expect = OPERATOR
						}
						break

					default:
						type = BRACKET_END
						expect = OPERATOR
				}

				tokens.push(m5)
			}

			lastType = type
			types.push(type)
		}

		if (lastType === KEYWORD_OPERATOR) {
			types[types.length - 1] = VARIABLE
		}

		return {
			types,
			tokens,
			filterIndex,
			lastExpressionIndex,
			hasSafeGetter,
		}
	},


	//a + b -> this.a + this.b
	//a() -> this._writeScope.a()
	//a=... -> this._writeScope.a = ...
	addScopeToTokens (types, tokens) {
		let variableIndex = -1
		let variableIndexStack = []
		let lastType = null
		let scopeName = 'this'
		let assignOrCallScopeName = scopeName + '._writeScope'

		for (let i = 0, len = tokens.length; i < len; i++) {
			let type = types[i]
			let token = tokens[i]

			//add scope
			if (lastType === VARIABLE) {
				switch (token) {
					case '(':
					case '=':
						tokens[variableIndex] = assignOrCallScopeName + '.' + tokens[variableIndex]
						break

					default:
						tokens[variableIndex] = scopeName + '.' + tokens[variableIndex]
				}
			}

			switch (type) {
				case VARIABLE:
					variableIndex = i
					break

				case BRACKET_START:
					variableIndexStack.push(variableIndex)
					variableIndex = -1
					break

				case BRACKET_END:
					variableIndex = variableIndexStack.pop()
					break
			}

			lastType = type
		}

		if (lastType === VARIABLE) {
			tokens[variableIndex] = scopeName + '.' + tokens[variableIndex]
		}
	},


	//a?.b -> ff.safeProperty(this.a, ['b'])
	//a?.b?.c -> ff.safeProperty(this.a, ['b', 'c'])
	//a?.b.c() -> ff.safeProperty(this.a, ['b'], v=>v.c()])
	//a?b(...) -> ff.safeCall(this.a, ['b'], ...)
	//a?b = ... -> ff.safeAssign(this.a, ['b'], ...)
	addSafeGetterToTokens (types, tokens) {
		let stack = []
		let variableIndex = -1
		let restIndex = -1
		let inCallArgs = false
		let safeAssignDeep = 0

		let endOfSafe = (i) => {
			if (restIndex >= 0) {
				if (restIndex < i) {
					tokens[restIndex] = '],v=>v' + tokens[restIndex]
					tokens[i-1] += ')'
				}
				else {
					tokens[i-1] += '])'
				}

				restIndex = -1
			}
		}

		for (let i = 0, len = tokens.length; i < len; i++) {
			let token = tokens[i]
			let type = types[i]

			if (token === '?.') {
				if (restIndex >= 0) {
					endOfSafe(i)
				}

				tokens[i] = ',['

				for (i++; i < len; i++) {
					type = types[i]
					token = tokens[i]

					if (token === '?.') {
						tokens[i] = ','
					}
					else if (types[i] === PROPERTY) {
						tokens[i] = '\'' + token + '\''
					}
					else {
						break
					}
				}

				switch (token) {
					case '=':
						tokens[variableIndex] = 'ff.safeAssign(' + tokens[variableIndex]
						tokens[i] = '],'
						safeAssignDeep++
						break

					case '(':
						tokens[variableIndex] = 'ff.safeCall(' + tokens[variableIndex]
						tokens[i] = '],['
						inCallArgs = true
						break

					case '.':
					case '[':
						tokens[variableIndex] = 'ff.safeProperty(' + tokens[variableIndex]
						restIndex = i
						break

					default:
						tokens[variableIndex] = 'ff.safeProperty(' + tokens[variableIndex]
						tokens[i - 1] += '])'
				}
			}

			switch (type) {
				case VARIABLE:
				case KEYWORD_VALUE:
					variableIndex = i
					break

				case OPERATOR:
					if (restIndex >= 0 && token !== '.' && token !== '=') {
						endOfSafe(i)
					}
					break

				case BRACKET_START:
					stack.push([variableIndex, restIndex, inCallArgs])
					variableIndex = -1
					restIndex = -1
					break

				case BRACKET_END:
					if (restIndex >= 0) {
						tokens[restIndex] = '],v=>v' + tokens[restIndex]
						tokens[i-1] += ')'
					}

					[variableIndex, restIndex, inCallArgs] = stack.pop()

					if (inCallArgs) {
						tokens[i] = ''
						restIndex = i + 1
					}
					break
			}
		}

		if (safeAssignDeep > 0) {
			tokens[tokens.length - 1] += ')'.repeat(safeAssignDeep)
		}
		
		if (restIndex >= 0) {
			endOfSafe(tokens.length)
		}
	},


	bindScopeToTemplateString(str) {
		return str.replace(lexer.TEMPLATE_REGEXP, (m0, m1) => {
			return '${' + lexer.bindScope(m1).returnedCode + '}'
		})
	},


	parseFilters (exp, startIndex) {
		let re = lexer.FILTER_REGEXP
		re.lastIndex = startIndex

		let reFn = lexer.FILTER_FN_REGEXP
		let filters = []

		while (true) {
			let m = re.exec(exp)

			if (!m) {
				break
			}

			let [, name, argStr] = m
			let args

			if (argStr) {
				argStr = argStr.trim()
			}

			if (argStr && reFn.test(argStr)) {
				args = lexer.bindScope(argStr.slice(1, -1)).returnedCode
			}
			else if (argStr) {
				args = argStr.split(/\s+/).map(v => `'${v.replace(/'/g, '\\')}'`).join(', ')
			}
			else {
				args = ''
			}

			filters.push({name, args})
		}
	
		return filters
	},


	//a -> function () { return this.a }
	//a | b c -> function () { return this.filters[b](this.a, 'c') }
	//a | b(c) -> function () { return this.filters[b](this.a, this.c) }
	//a | b(c) | d(e) -> function () { return dFn(this.filters[b](this.a, this.c), this.e) }
	compileReader (exp, ...args) {
		let key = exp + args.map(v => ';' + v)
		let fn = lexer.readerCache[key]

		if (fn) {
			return fn
		}

		let {previousCode, returnedCode} = lexer.compileReaderToCode(exp, args)

		return lexer.readerCache[key] = new Function(previousCode + 'return ' + returnedCode)
	},


	compileReaderToCode (exp, args) {
		let {previousCode, returnedCode, filters} = lexer.bindScope(exp, args)

		if (filters) {
			for (let {name, args} of filters) {
				args = args ? ', ' + args : ''
				returnedCode = `this.filters['${name}'](${returnedCode}${args})`
			}
		}

		return {
			previousCode,
			returnedCode,
		}
	},


	compileHandler (exp) {
		let key = exp
		let fn = lexer.handlerCache[key]

		if (fn) {
			return fn
		}

		if (!exp) {
			return lexer.handlerCache[key] = new Function('')
		}
		else if (lexer.isEntireProperty(exp)) {
			let {returnedCode} = lexer.bindScope(exp + '(..._args)', ['_args'])
			return lexer.handlerCache[key] = new Function('..._args', 'return ' + returnedCode)
		}
		else {
			let {previousCode, returnedCode} = lexer.bindScope(exp, ['event'])
			return lexer.handlerCache[key] = new Function('event', previousCode + 'return ' + returnedCode)
		}
	},


	//a -> function (vm, value) { vm.a = value }
	//a | b(c) -> function (vm, value) { vm.a = this.filters[b](value, this.c) }
	//vm is the scope which has own property a
	compileWritter (exp) {
		let key = exp
		let fn = lexer.writterCache[key]

		if (fn) {
			return fn
		}

		if (!lexer.isEntireProperty(ff.before(exp, '|', true))) {
			throw new Error(`Model expression "${exp}" is not a property`)
		}

		let {types, tokens, filterIndex, lastExpressionIndex, hasSafeGetter} = lexer.parseToTokens(exp)
		let valueCode = 'value'

		if (filterIndex > 0) {
			let filters = lexer.parseFilters(exp, filterIndex)

			for (let {name, args} of filters) {
				args = args ? ', ' + args : ''
				valueCode = `this.filters['${name}'](${valueCode}${args})`
			}
		}

		types.push(OPERATOR)
		tokens.push('=')
		this.addScopeToTokens(types, tokens)
		types.push(KEYWORD_VALUE)
		tokens.push(valueCode)

		if (hasSafeGetter) {
			this.addSafeGetterToTokens(types, tokens)
		}

		let previousCode = tokens.slice(0, lastExpressionIndex).join('')
		let returnedCode = tokens.slice(lastExpressionIndex).join('')

		return lexer.writterCache[key] = new Function('value', previousCode + returnedCode)
	},


	//a {{b}} c -> function () {return 'a' + b() + 'c'}
	compileDelimiterExpression (text) {
		let fn = lexer.delimiterCache[text]
		if (fn) {
			return fn
		}

		let re = lexer.DELIMITER_REGEXP
		re.lastIndex = 0

		let exps = []
		let startIndex = 0
		let m

		while (m = re.exec(text)) {
			let [m0, exp] = m
			let str = text.slice(startIndex, re.lastIndex - m0.length)

			if (str) {
				exps.push(lexer.toStringCode(str))
			}

			let {previousCode, returnedCode} = lexer.compileReaderToCode(exp)
			exps.push('(' + previousCode + returnedCode + ')')

			startIndex = re.lastIndex
		}

		if(startIndex < text.length) {
			exps.push(lexer.toStringCode(text.slice(startIndex)))
		}

		if (exps.length > 1) {
			exps.push("''")
		}

		return lexer.delimiterCache[text] = new Function('return ' + exps.join('+')) 
	},


	compileIfStatements (exps, hasElse) {
		let codes = []

		for (let i = 0, len = exps.length; i < len; i++) {
			let exp = exps[i]
			let {previousCode, returnedCode} = lexer.compileReaderToCode(exp)

			codes.unshift(previousCode)
			codes.push((i > 0 ? 'else ' : '') + `if(${returnedCode}){return ${i}}`)
		}

		if (hasElse) {
			codes.push(`else{return ${exps.length}}`)
		}
		else {
			codes.push('else{return -1}')
		}

		let exp = codes.join('')
		let fn = lexer.readerCache[exp]
		if (fn) {
			return fn
		}

		return lexer.readerCache[exp] = new Function(exp)
	},


	parseForLoop (exp) {
		let loop = this.loopCache[exp]
		if (loop) {
			return loop
		}

		let m = exp.match(lexer.FOR_LOOP_REGEXP)
		let valueExp

		if (m) {
			let [, props, type, dataKey] = m

			loop = {type, dataKey}

			if (type === 'in') {
				m = props.match(lexer.FOR_IN_LOOP_REGEXP)

				if (!m) {
					throw new Error(`"${exp}" is not a valid "for" expression`)
				}

				let [, keyKey, valueKey, indexKey] = m

				loop.keyKey = keyKey
				loop.indexKey = indexKey
				valueExp = valueKey
			}
			else if (type === 'of') {
				m = props.match(lexer.FOR_OF_LOOP_REGEXP)

				if (!m) {
					throw new Error(`"${exp}" is not a valid "for" expression`)
				}

				let [, valueKey, indexKey] = m

				loop.indexKey = indexKey
				valueExp = valueKey
			}
		}

		else {
			m = exp.match(lexer.FOR_TO_LOOP_REGEXP)

			if (!m) {
				throw new Error(`"${exp}" is not a valid "for" expression`)
			}

			let [, valueKey, fromKey, toKey, stepKey] = m

			if (!lexer.isSingleVariable(valueKey)) {
				throw new Error(`"${exp}" is not a valid "for" expression`)
			}

			loop = {
				type: 'to',
				fromKey,
				toKey,
			}

			loop.stepKey = stepKey || 1
			valueExp = valueKey
		}

		if (valueExp) {
			loop.valueAssigner = lexer.parseAssigner(valueExp)
		}

		return this.loopCache[exp] = loop
	},


	parseAssigner (exp) {
		let {previousCode, returnedCode} = lexer.bindScope(exp)
		return new Function('value', '(' + previousCode + returnedCode + ' = value)')
	},
}


const skipLinkingSymbol = Symbol('skip-linking')
const canHaveElseSymbol = Symbol('can-have-else')

//compile a el to a linkFn, call which will bind all directives to a cloned el(or original el)
const compiler = {

	PREFIX: 'f-',

	DIR_RE: /^(?:f-|[@:])/,

	SHORT_DIR_NAME_MAP: {
		'@': 'on',
		':': 'bind',
	},


	//when cimpiling by component directive
	compile (vm, linkEl, compilingComponent) {
		let linkFn = this.compileChild(vm, linkEl, true, compilingComponent)

		return function (newEl) {
			let prevEl = newEl.previousSibling
			let parent

			if (!prevEl) {
				parent = newEl.parentNode

				if (!parent) {
					parent = document.createDocumentFragment()
					parent.append(newEl)
				}
			}

			//not pass the parent argument, newEl was cloned outside, no need to handle its cloning twice
			linkFn.call(this, newEl, null)

			if (prevEl) {
				return prevEl.nextSibling
			}
			else {
				return parent.firstChild
			}
		}
	},


	compileChild (vm, el, isRoot, compilingRootComponent) {
		let {isTerminal, linkDir} = this.compileDirectives(vm, el, isRoot, compilingRootComponent)
		let childNodes = [...el.childNodes]
		let linkSub = []

		if (isTerminal) {
			el.remove()
		}
		else {
			for (let i = 0, len = childNodes.length; i < len; i++) {
				let child = childNodes[i]
				let linkFn = this.willSkipCompile(child) ? null : this.compileChild(vm, child, false, false)

				linkSub.push(linkFn)
			}
		}

		let len = linkSub.length

		return function (newEl, newElParent) {
			let com
			let oldEl = el

			//if one directive is terminal, and newEl is not root element, what we choose is to remove it when compiling, and the clone it to insert its previous position when linking
			if (isTerminal && newElParent) {
				if (linkDir) {
					let nextEl = newEl
					newEl = el.cloneNode(true)
					newElParent.insertBefore(newEl, nextEl)
					com = linkDir.call(this, newEl)
				}
			}
			else {
				if (newEl[skipLinkingSymbol]) {
					return false
				}

				let childNodes = [...newEl.childNodes]

				if (linkDir) {
					com = linkDir.call(this, newEl)
				}

				for (let i = 0, terminalCount = 0; i < len; i++) {
					let linkFn = linkSub[i]
					if (linkFn) {
						let isTerminal = linkFn.call(this, childNodes[i - terminalCount], newEl)
						if (isTerminal) {
							terminalCount++
						}
					}
				}
			}

			if (com) {
				com._onChildrenLinked()
			}

			return isTerminal
		}
	},


	willSkipCompile (el) {
		let {localName} = el
		return localName === 'script'
	},


	compileDirectives (vm, el, isRoot, compilingRootComponent) {
		let dirs = []
		let {nodeType} = el
		let isTerminal = false
		let linkDir = null

		if (nodeType === 1) {
			for (let i = 0, len = el.attributes.length; i < len; i++) {
				let {name, value} = el.attributes[i]
				let dir = this.getDirFromAttribute(vm, el, name, value)
				if (dir) {
					dirs.push(dir)
				}
			}

			if (!compilingRootComponent) {
				let dir = this.getComponentDir(vm, el)
				if (dir) {
					dirs.push(dir)
				}
			}
		}
		else if (nodeType === 3) {
			let text = el.textContent

			if (lexer.isDelimiterExpression(text)) {
				dirs.push({
					name: 'text',
					exp: text,
					isTextual: true,
				})
			}
		}

		if (dirs.length === 0) {
			return {
				isTerminal,
				linkDir,
			}
		}

		if (nodeType === 1) {
			this.checkComBinds(dirs)
			this.checkRef(dirs, el)
		}

		this.inheritDirFromProto(vm, dirs)

		if (nodeType === 1) {
			this.sortDirs(dirs)
			isTerminal = this.checkTerminal(dirs)
			this.cleanDirAttributes(dirs, el)
		}

		if (isTerminal && dirs.length === 1 && ['else-if', 'else'].includes(dirs[0].name)) {
			return {
				isTerminal,
				linkDir,
			}
		}

		this.callDirCompile(vm, dirs, el)

		let watcherGetters = dirs.map(dir => this.prepareWatcherGetter(dir, el))
		let len = dirs.length

		linkDir = function (newEl) {
			let binds = []
			let com

			for (let i = 0; i < len; i++) {
				let dirProto = dirs[i]
				let {name} = dirProto
				let getter = watcherGetters[i]

				let dir = {
					__proto__: dirProto,
					vm: this[proxySymbol],
					el: newEl,
					watcher: null,
				}

				if (name === 'component') {
					dir.binds = binds
				}

				compiler.bindDirective(this, dir, getter)

				if (name === 'component') {
					com = dir.com
					newEl = com.el
				}
				else if (name === 'com-bind' || name === 'com-model') {
					binds.push(dir)
				}
			}

			return com
		}

		return {
			isTerminal,
			linkDir,
		}
	},


	getDirFromAttribute (vm, el, nodeName, nodeValue) {
		if (compiler.DIR_RE.test(nodeName) || nodeName === 'trans') {
			let {name, prop, mods} = this.parseNodeName(nodeName)

			if (name) {
				if (name === 'if' || name === 'else-if') {
					if (el.nextElementSibling) {
						el.nextElementSibling[canHaveElseSymbol] = true
					}
				}
				
				if (name === 'else-if' || name === 'else') {
					if (!el[canHaveElseSymbol]) {
						throw new Error(`"${name}" directive must after "if" or "else-if"`)
					}

					delete el[canHaveElseSymbol]
				}

				if ((name === 'if' || name === 'for') && el.hasAttribute('slot')) {
					throw new Error(`"slot" el should not have "if" or "for" directive`)
				}

				if (vm.directives[name]) {
					let dir = {
						name,
						exp: nodeValue,
						nodeName,
					}

					if (prop) {
						dir.prop = prop
					}

					if (mods) {
						dir.mods = mods
					}

					return dir
				}
				else {
					console.warn(`Directive "${name}" is not registered`)
				}
			}
		}
		else if (lexer.isDelimiterExpression(nodeValue)) {
			let dir = {
				name: 'bind',
				prop: 'attr',
				mods: [nodeName],
				exp: nodeValue,
				isTextual: true,
			}

			return dir
		}
	},


	parseNodeName (nodeName) {
		let {PREFIX, SHORT_DIR_NAME_MAP} = compiler
		let name, rest, prop, mods

		if (nodeName.startsWith(PREFIX)) {
			let unprefixNodeName = nodeName.slice(PREFIX.length)
			name = unprefixNodeName.match(/^[\w-]+/)[0]
			rest = unprefixNodeName.slice(name.length)
		}
		else if (name = SHORT_DIR_NAME_MAP[nodeName[0]]) {
			rest = nodeName
		}
		else {
			name = nodeName.match(/^[\w-]+/)[0]
			rest = nodeName.slice(name.length)
		}

		if (rest) {
			[prop, ...mods] = rest.split('.')

			if (prop) {
				prop = prop.slice(1)
			}
		}

		return {
			name,
			prop,
			mods,
		}
	},


	getComponentDir (vm, el) {
		let {localName} = el
		let exp

		if (vm.components[localName]) {
			exp = localName
		}
		else if (localName.includes('-')) {
			console.warn(`"${localName}" may be a component name but not been registered`)
		}

		if (exp) {
			let dir = {
				name: 'component',
				exp,
				inner: el.hasAttribute('inner'),
			}

			if (dir.inner) {
				dir.isTerminal = true
			}

			//sepcify a component name as a marker, and a child component selector
			el.setAttribute('is', exp)

			return dir
		}
	},


	getComponentName (vm, el) {
		let {localName} = el

		if (vm.components[localName]) {
			return localName
		}
		else if (localName.includes('-')) {
			console.warn(`"${localName}" may be component but not registered`)
		}

		return ''
	},


	checkRef (dirs, el) {
		let refIndex = dirs.findIndex(dir => dir.name === 'ref')
		if (refIndex > -1) {
			let forOrComIndex = dirs.findIndex(dir => dir.name === 'for' || dir.name === 'component')

			if (forOrComIndex > -1) {
				let forOrComDir = dirs[forOrComIndex]
				forOrComDir.ref = dirs[refIndex].exp
				forOrComDir.secondaryNodeName = 'f-ref'
				dirs.splice(refIndex, 1)
			}
		}
	},


	checkComBinds (dirs) {
		let componentDirIndex = dirs.findIndex(dir => dir.name === 'component')

		if (componentDirIndex > -1) {
			for (let dir of dirs) {
				let {name, prop} = dir

				if (name === 'bind' && !['attr', 'class', 'style'].includes(prop)) {
					dir.name = 'com-bind'
				}
				else if (name === 'model') {
					dir.name = 'com-' + name
				}
			}
		}
	},


	inheritDirFromProto (vm, dirs) {
		for (let dir of dirs) {
			dir.__proto__ = vm.directives[dir.name]
		}
	},


	sortDirs (dirs) {
		dirs.sort((a, b) => {
			return b.priority - a.priority
		})
	},


	checkTerminal (dirs) {
		let isTerminal = false

		let terminalIndex = dirs.findIndex(dir => {
			return dir.isTerminal
		})

		if (terminalIndex > -1) {
			let dir = dirs[terminalIndex]
			let isInnerComponent = dir.name === 'component' && dir.inner

			isTerminal = true

			if (!isInnerComponent) {
				dirs.splice(terminalIndex + 1, dirs.length - terminalIndex - 1)
			}
		}

		return isTerminal
	},


	cleanDirAttributes (dirs, el) {
		for (let dir of dirs) {
			if (dir.nodeName) {
				el.removeAttribute(dir.nodeName)
			}

			if (dir.secondaryNodeName) {
				el.removeAttribute(dir.secondaryNodeName)
				delete dir.secondaryNodeName
			}
		}
	},


	callDirCompile (vm, dirs, el) {
		for (let dir of dirs) {
			if (dir.onCompile) {
				dir.onCompile(el, vm)
			}
		}
	},


	prepareWatcherGetter (dir, el) {
		let {exp, name} = dir
		let getter = null

		if (dir.isLiteral) {
			if (lexer.isDelimiterExpression(exp)) {
				getter = lexer.compileDelimiterExpression(exp)
			}
		}
		else if (dir.isTextual) {
			getter = lexer.compileDelimiterExpression(exp)
		}	
		else if (dir.isListener) {
			getter = lexer.compileHandler(exp, 'event')
		}
		else if (name === 'if') {
			let {exps, hasElse} = dir
			getter = lexer.compileIfStatements(exps, hasElse)
		}
		else if (name === 'for') {
			let loop = dir.loop = lexer.parseForLoop(exp)
			let {type} = loop

			if (type === 'to') {
				getter = lexer.compileReader(`[${loop.fromKey}, ${loop.toKey}, ${loop.stepKey}]`)
			}
			else {
				getter = lexer.compileReader(loop.dataKey)
			}
		}
		else {
			getter = lexer.compileReader(exp)
		}

		return getter
	},


	bindDirective (vm, dir, getter) {
		let {exp} = dir
		let value

		if (dir.bind) {
			dir.bind()
		}
		
		if (dir.isListener) {
			value = getter
		}
		else if (dir.update && getter) {
			let watcher = new Watcher({
				vm,
				exp,
				getter,
				handler: dir.update,
				scope: dir,
			}, true)

			vm._watchers.push(watcher)
			dir.watcher = watcher
			value = watcher.value
		}
		else if (getter) {
			value = getter.call(vm)
		}
		else if (dir.isLiteral) {
			value = exp
		}

		vm._directives.push(dir)

		if (!dir.name.startsWith('com-') && dir.update) {
			dir.update(value)
		}
	},
}



//watcher, used to get or set value by expression and vm
function Watcher (options, isDir) {
	ff.assign(this, options)

	this.id = Watcher.seed++
	this.deps = {}

	if (isDir) {
		let {name} = this.scope
		this.updateEvenVMInactive = name === 'transition'
		this.updateForceWhenDigest = name === 'com-bind' || name === 'com-model'
	}
	else {
		this.scope = this.vm[proxySymbol]
		this.updateEvenVMInactive = false
		this.updateForceWhenDigest = false

		if (!this.getter) {
			this.getter = lexer.compileReader(this.exp)
		}
	}

	this.value = this.get()
}

Watcher.seed = 1
Watcher.running = null

Watcher.prototype = {

	get () {
		let oldDeps = this.deps
		let newDeps = this.deps = {}
		let value

		Watcher.running = this

		try {
			value = this.getter.call(this.vm._readScope[proxySymbol])
		}
		catch (err) {
			console.warn(`Failed to run "${this.exp}" - `, err.stack)
			this.deps = oldDeps
			return this.value
		}

		Watcher.running = null

		for (let key in oldDeps) {
			let oldObserver = oldDeps[key]
			if (!newDeps[key]) {
				let name = key.slice(key.indexOf('_') + 1)
				oldObserver.removeWatcher(name, this)
			}
		}

		return value
	},


	set (value) {
		let {vm} = this
		let setter = lexer.compileWritter(this.exp)
		
		setter.call(vm[proxySymbol], value)
	},


	update () {
		queues.addWatcher(this)
	},


	//returns needs to update and truly updated
	updateNow (forceDigest) {
		let oldValue = this.value
		let newValue = this.get()

		if (newValue !== oldValue || forceDigest && this.updateForceWhenDigest) {
			this.value = newValue
			this.handler.call(this.scope, newValue, oldValue)
		}
	},


	addDep (name, observer) {
		let key = observer.id + '_' + name
		this.deps[key] = observer
	},


	removeAllDeps () {
		let {deps} = this

		for (let key in deps) {
			let observer = deps[key]
			let name = key.slice(key.indexOf('_') + 1)

			observer.removeWatcher(name, this)
		}
	},


	destroy () {
		this.removeAllDeps()
	},
}



//recycle empty map after watcher removed from observer
let observerWatcherMapWillBeRecycled = {}

function willRecycleEmptyMapOnObserver (observer, name) {
	observerWatcherMapWillBeRecycled[observer.id + '_' + name] = observer
}

function recycleEmptyMap () {
	for (let key in observerWatcherMapWillBeRecycled) {
		let watcherMap = observerWatcherMapWillBeRecycled[key].watcherMap
		let name = key.slice(key.indexOf('_') + 1)
		let map = watcherMap[name]

		if (util.isEmptyObject(map)) {
			delete watcherMap[name]
		}
	}

	observerWatcherMapWillBeRecycled = {}
	recycleEmptyMapLater()
}

function recycleEmptyMapLater () {
	setTimeout (function () {
		typeof requestIdleCallback === 'function' ? requestIdleCallback(recycleEmptyMap) : recycleEmptyMap()
	}, 10000)
}

recycleEmptyMapLater()



//used to collected watchers and trigger changes on object and array
const observerSymbol = Symbol('observer')
const arrayProto = Array.prototype

const Observer = function Observer (obj) {
	this.changes = []
	this.events = []
	this.watcherMap = {}
	this.id = Observer.seed++

	if (util.isArray(obj)) {
		this.startIndex = Infinity
		Object.defineProperties(obj, Observer.arrayMethodsOverwrite)
	}

	obj[observerSymbol] = this
	this.target = obj
}

Observer.seed = 1

Observer.arrayMethodsOverwrite = {

	push: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let startIndex = target.length
			let returns = arrayProto.push.call(target, ...args)

			observer.onArrayChange(startIndex)
			return returns
		},
	},

	pop: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let returns = arrayProto.pop.call(target, ...args)
			let startIndex = target.length

			observer.onArrayChange(startIndex)
			return returns
		},
	},

	unshift: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let returns = arrayProto.unshift.call(target, ...args)

			observer.onArrayChange(0)
			return returns
		},
	},

	splice: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let startIndex = args[0]
			let returns = arrayProto.splice.call(target, ...args)

			observer.onArrayChange(startIndex)
			return returns
		},
	},

	shift: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let returns = arrayProto.shift.call(target, ...args)

			observer.onArrayChange(0)
			return returns
		},
	},

	sort: {
		value (...args) {
			let observer = this[observerSymbol]
			let target = this[targetSymbol] || this
			let returns = arrayProto.sort.call(target, ...args)

			observer.onArrayChange(0)
			return returns
		},
	},
}


Observer.prototype = {

	addWatcher (name, watcher) {
		let observer = this
		let {target} = this

		if (!target.hasOwnProperty(name) && target._inherit) {
			observer = this.findObserverHasOwnProperty(name)
		}

		let {watcherMap} = observer
		let map = watcherMap[name]

		if (!map) {
			map = watcherMap[name] = {}
		}

		map[watcher.id] = watcher
		watcher.addDep(name, observer)
	},


	findObserverHasOwnProperty (name) {
		let vm = this.target

		do {
			vm = vm._parent._readScope
		}
		while (vm && vm._inherit && !vm.hasOwnProperty(name))

		if (!vm) {
			vm = this.target._writeScope
		}

		return vm[observerSymbol]
	},


	removeWatcher (name, watcher) {
		let {watcherMap} = this
		let map = watcherMap[name]

		delete map[watcher.id]

		willRecycleEmptyMapOnObserver(this, name)
	},


	onObjectChange (name) {
		let {watcherMap} = this
		let map = watcherMap[name]

		if (map) {
			for (let id in map) {
				map[id].update()
			}
		}

		if (this.events.length > 0) {
			queues.addObserver(this)
		}
	},


	onArrayChange (startIndex) {
		//we need to handle watcher maps according to flush observer
		queues.addArrayObserver(this)

		if (this.events.length > 0) {
			queues.addObserver(this)
		}
	},


	addHandler (handler, scope) {
		this.events.push({
			handler,
			scope,
		})
	},


	removeHandler (handler, scope) {
		let {events} = this

		for (let i = events.length - 1; i >= 0; i--) {
			let event = events[i]
			if (event.handler === handler && event.scope === scope) {
				events.splice(i, 1)
				break
			}
		}
	},


	updateArrayWatchers () {
		let {watcherMap, startIndex} = this

		for (let name in watcherMap) {
			if (name === 'length' || name >= startIndex) {
				let map = watcherMap[name]
				for (let id in map) {
					map[id].update()
				}
			}
		}

		this.startIndex = Infinity
	},


	flush () {
		let {events} = this

		for (let i = 0, len = events.length; i < len; i++) {
			let event = this.events[i]

			try {
				event.handler.call(event.scope, this.target)
			}
			catch (err) {
				console.warn(err)
			}
		}
	},
}



//proxy is used to capture get and set operators, and generate a dependency tree
//when set operator called, it will trigger all related watchers which run in getting process
//May Object.observe and Array.observe's soul rest in peace
const proxySymbol = Symbol('proxy')
const targetSymbol = Symbol('target')

const observerManager = {

	observe (obj) {
		return this.createProxy(obj)
	},


	observeIfNot (obj) {
		let proxy = obj[proxySymbol]
		if (proxy) {
			return proxy
		}

		return this.createProxy(obj)
	},


	createProxy (obj) {
		let observer = new Observer(obj)

		let proxy = new Proxy(obj, {

			get (obj, name, proxy) {
				// uncomment this would make getter been listened, but I don't think getter is good enough in readability and intelligibility
				// let descriptor = util.getPropertyDescriptor(obj, name)
				// if (descriptor && descriptor.get) {
				// 	return descriptor.get.call(proxy)
				// }

				let value = obj[name]

				if (typeof name === 'symbol') {
					return value
				}

				let type = typeof value
	
				if (type === 'function') {
					return value
				}

				let runningWatcher = Watcher.running

				if (type === 'object' && value !== null) {
					let subProxy = value[proxySymbol]
					if (subProxy) {
						value = subProxy
					}
					else if (runningWatcher) {
						let str = toString.call(value)
						if (str === '[object Object]' || str === '[object Array]') {
							value = observerManager.observe(value)
						}
					}
				}

				if (runningWatcher) {
					observer.addWatcher(name, runningWatcher)
				}

				return value
			},

			//can't get old length using obj.length from array
			//set array[index] will not cause length change, so never do it
			//add a property to obj will not cause JSON.stringify(obj) watcher triggerred
			set (obj, name, value) {
				if (typeof name === 'symbol') {
					obj[name] = value
				}
				else {
					let oldValue = obj[name]

					if (oldValue !== value || Array.isArray(obj) && name === 'length') {
						obj[name] = value
						observer.onObjectChange(name)
					}
				}

				return true
			},

			has (obj, name) {
				if (typeof name !== 'symbol' && Watcher.running) {
					observer.addWatcher(name, Watcher.running)
				}

				return name in obj
			},

			deleteProperty (obj, name) {
				if (obj.hasOwnProperty(name)) {
					if (typeof name !== 'symbol') {
						observer.onObjectChange(name)
					}

					return delete obj[name]
				}
				else {
					return true
				}
			},

			//not available currently, it will affect the watching for JSON.stringify(obj)
			// ownKeys (obj) {

			// },
		})

		obj[proxySymbol] = proxy
		obj[targetSymbol] = obj

		return proxy
	},


	observeChanges (obj, handler, scope) {
		let observer = obj[observerSymbol] || new Observer(obj)
		observer.addHandler(handler, scope)
	},


	unobserveChanges (obj, handler, scope) {
		let observer = obj[observerSymbol]
		if (observer) {
			observer.removeHandler(handler, scope)
		}
	},
}



//run directive type of watcher, then user created watcher, then task
const queues = {

	started: null,

	flushing: false,

	watchers: [],

	watcherMap: {},

	watcherDepsTree: {},	//watcher id => id of watcher which started it 

	observers: [],

	observerMap: {},

	arrayObservers: [],

	arrayObserverMap: {},

	innerTasks: [],

	userTasks: [],

	step: 0,


	addWatcher (watcher) {
		if (this.updatingWatcher) {
			if (this.checkWatcherCirculation(watcher)) {
				return
			}
		}

		let {watchers} = this
		let {id} = watcher

		if (!watcher.vm._inactiveState && !this.watcherMap[id]) {
			if (this.step === 1) {
				this.binaryInsert(watchers, watcher)
			}
			else {
				watchers.push(watcher)
				this.startDeferredFlushingIfNot()
			}

			this.watcherMap[id] = true
		}
	},


	binaryInsert (items, item) {
		let index = this.getBinaryInsertIndex(items, item)
		items.splice(index, 0, item)
	},


	getBinaryInsertIndex (watchers, watcher) {
		let {id} = watcher
		let len = watchers.length

		if (len === 0) {
			return 0
		}

		let startId = watchers[0].id
		if (id < startId) {
			return 0
		}

		if (len === 1) {
			return 1
		}

		let endId = watchers[len - 1].id
		if (id > endId) {
			return len
		}

		let start = 0
		let end = len - 1

		while (end - start > 1) {
			let center = Math.floor((end + start) / 2)
			let centerId = watchers[center].id

			if (id < centerId) {
				end = center
			}
			else {
				start = center
			}
		}

		return end
	},


	checkWatcherCirculation (watcher) {
		let {updatingWatcher, watcherDepsTree} = this
		let {id} = watcher
		let depWatcher = updatingWatcher
		let isInCirculation = false

		do {
			if (depWatcher.id === id) {
				isInCirculation = true
				break
			}

			depWatcher = watcherDepsTree[depWatcher.id]
		}
		while (depWatcher)

		if (isInCirculation) {
			let depWatcher = updatingWatcher
			let watchers = [watcher]

			do {
				watchers.unshift(depWatcher)

				if (depWatcher.id === id) {
					break
				}

				depWatcher = watcherDepsTree[depWatcher.id]
			}
			while (depWatcher)

			let expChain = watchers.map(v => v.exp).join(' -> ')
			console.warn(`Watchers "${expChain}" is updating circularly`)
			
			return true
		}
		else {
			watcherDepsTree[id] = updatingWatcher
			return false
		}
	},


	addObserver (observer) {
		let {observers} = this
		let {id} = observer

		if (!this.observerMap[id]) {
			if (this.step === 2) {
				this.binaryInsert(observers, observer)
			}
			else {
				observers.push(observer)
				this.startDeferredFlushingIfNot()
			}

			this.observerMap[id] = true
		}
	},


	addArrayObserver (observer) {
		let {arrayObservers} = this
		let {id} = observer

		if (!this.arrayObserverMap[id]) {
			if (this.step > 0) {
				observer.updateArrayWatchers()
			}
			else {
				arrayObservers.push(observer)
				this.startDeferredFlushingIfNot()
			}

			this.arrayObserverMap[id] = true
		}
	},


	//used to update like transition properties, or model value overwrite before user task
	//it should never change any datas which have been observed
	pushInnerTask (fn, ...args) {
		this.innerTasks.push({
			fn,
			args,
		})

		this.startDeferredFlushingIfNot()
	},


	pushUserTask (fn, ...args) {
		this.userTasks.push({
			fn,
			args,
		})

		this.startDeferredFlushingIfNot()
	},


	startDeferredFlushingIfNot () {
		if (!this.started) {
			Promise.resolve().then(() => this.doFlushing())
			this.started = true
		}
	},


	doFlushing () {
		let {watchers, observers, arrayObservers, userTasks, innerTasks} = this

		this.flushing = true

		if (arrayObservers.length > 0) {
			this.runArrayObservers()
		}

		this.step = 1
		if (watchers.length > 0) {
			this.runWatchers()
		}

		this.step = 2
		if (observers.length > 0) {
			this.runObservers()
		}

		this.step = 3

		if (innerTasks.length > 0) {
			this.runInnerTasks()
		}

		if (userTasks.length) {
			this.runUserTasks()
		}

		this.step = 0
		this.watcherDepsTree = {}
		this.started = false
		this.flushing = false
	},


	runWatchers () {
		let {watchers, watcherMap} = this

		watchers.sort((v1, v2) => v1.id - v2.id)

		while (watchers.length > 0) {
			let watcher = watchers.shift()
			let {vm, id} = watcher

			if (!vm._destroyed && (!vm._inactiveState || watcher.updateEvenVMInactive)) {
				this.updatingWatcher = watcher
				watcher.updateNow()
			}

			delete watcherMap[id]
		}

		this.updatingWatcher = null
	},


	runObservers () {
		let {watchers, observers, observerMap} = this

		observers.sort((v1, v2) => v1.id - v2.id)

		//must behind directive watchers, because should handle f-for data changes firstly, and then handle its partly observer changes
		while (observers.length > 0) {
			let observer = observers.shift()
			observer.flush()
			delete observerMap[observer.id]

			if (watchers.length > 0) {
				this.runWatchers()
			}
		}
	},


	runArrayObservers () {
		let {arrayObservers, arrayObserverMap} = this

		arrayObservers.sort((v1, v2) => v1.id - v2.id)

		//must behind directive watchers, because should handle f-for data changes firstly, and then handle its partly observer changes
		while (arrayObservers.length > 0) {
			let observer = arrayObservers.shift()
			observer.updateArrayWatchers()
			delete arrayObserverMap[observer.id]
		}
	},


	runInnerTasks () {
		let {innerTasks} = this

		while (innerTasks.length > 0) {
			let {fn, args} = innerTasks.shift()
			fn(...args)
		}
	},


	runUserTasks () {
		let {userTasks, watchers, observers, innerTasks} = this

		while (userTasks.length > 0) {
			let {fn, args} = userTasks.shift()

			try {
				fn(...args)
			}
			catch (err) {
				console.warn(err)
			}

			if (watchers.length > 0) {
				this.runWatchers()
			}

			if (observers.length > 0) {
				this.runObservers()
			}

			if (innerTasks.length > 0) {
				this.runInnerTasks()
			}
		}
	},
}



//FF
const vmSymbol = Symbol('vm')

function FF (options) {
	ff.Emitter.call(this)
	observerManager.observe(this)

	if (options && options._inherit) {
		this._initWhenInherit(options)
	}
	else {
		this._init(options)
	}

	return this[proxySymbol]
}

ff.assign(FF, {

	//helpers
	lexer,

	nextTick: queues.pushUserTask.bind(queues),

	flush () {
		return new Promise(resolve => queues.pushUserTask(resolve))
	},

	observeChanges: observerManager.observeChanges.bind(observerManager),

	unobserveChanges: observerManager.unobserveChanges.bind(observerManager),


	//VM related
	topVMs: [],

	digest () {
		for (let vm of this.topVMs) {
			vm.digest()
		}
	},


	getVM (el) {
		let vm = el[vmSymbol]
		return vm ? vm[proxySymbol] : vm
	},


	getClosestVM (el) {
		let vm = el[vmSymbol]

		while (!vm && (el = el.parentNode)) {
			vm = el[vmSymbol]
		}

		return vm ? vm[proxySymbol] : vm
	},


	getDir (el) {
		let vm = FF.getClosestVM(el)
		let dirs = {}

		if (vm) {
			for (let dir of vm._directives) {
				if (dir.el === el || dir.el.nodeType === 3 && dir.el.parentNode === el) {
					dirs[dir.name] = dir
				}
			}
		}

		if (vm && vm._inherit) {
			vm = vm._parent
			
			for (let dir of vm._directives) {
				if (dir.el === el || dir.el.nodeType === 3 && dir.el.parentNode === el) {
					dirs[dir.name] = dir
				}
			}
		}

		return dirs
	},


	getProxy (obj) {
		return observerManager.observeIfNot(obj)
	},


	getTarget (obj) {
		return obj ? obj[targetSymbol] || obj : obj
	},


	getTransition (el) {
		return el[transitionSymbol]
	},


	_registerComponentAt (target, name, superName, options) {
		let superCom = superName ? target.components[superName] : FF
		if (!superCom) {
			throw new Error(`"${superName}" is not a registered component`)
		}

		let superProto = superCom.prototype		
		let comName = ff.capitalize(util.toCamerCase(name))

		let Com = new Function(`
			return function ${comName} (options) {
				return FF.call(this, options)
			}
		`)()

		FF._initOptions(options, superProto, true)
		options.__proto__ = superProto
		options.constructor = Com

		Com.prototype = options
		ff.assign(Com, ComponentSharedMethods)

		target.components[name] = Com
	},


	//must call before assigning
	_initOptions (options, proto, newOwnProperty) {
		FF._formatDirectivesAndFilters(options)

		let props = ['directives', 'filters', 'transitions']

		for (let prop of props) {
			if (newOwnProperty) {
				options[prop] = options[prop] || {}
				options[prop].__proto__ = proto[prop]
			}
			else if (options[prop]) {
				options[prop].__proto__ = proto[prop]
			}
		}

		if (options.components && proto.components) {
			options.components.__proto__ = proto.components

			for (let name in options.components) {
				FF._registerComponentAt(options, name, '', options.components[name])
			}
		}

		if (options.template && proto.template && typeof options.template === 'object' && typeof proto.template === 'object') {
			options.template.__proto__ = proto.template
		}

		if (options.mixins && proto.mixins) {
			options.mixins = proto.mixins.concat(options.mixins)
		}

		if (options.onCreated && proto.onCreated) {
			options.onCreated = FF._createFunctionSequence(proto.onCreated, options.onCreated)
		}

		if (options.onReady && proto.onReady) {
			options.onReady = FF._createFunctionSequence(proto.onReady, options.onReady)
		}

		if (options.onDestroy && proto.onDestroy) {
			options.onDestroy = FF._createFunctionSequence(proto.onDestroy, options.onDestroy)
		}
	},


	_formatDirectivesAndFilters (options) {
		let {directives, filters} = options

		if (directives) {
			for (let name in directives) {
				let opt = directives[name]

				if (typeof opt === 'function') {
					opt = {
						update: opt
					}
				}

				opt.name = name
				opt.priority = opt.priority || 0

				directives[name] = opt
			}
		}

		if (filters) {
			for (let name in filters) {
				let opt = filters[name]

				if (typeof opt === 'function') {
					opt = {
						read: opt,
					}
				}

				if (!opt.read) {
					opt.read = ff.self
				}

				if (!opt.write) {
					opt.write = ff.self
				}

				filters[name] = opt
			}
		}
	},


	_createFunctionSequence (fn1, fn2) {
		return function (...args) {
			fn1.call(this, args)
			fn2.call(this, args)
		}
	},



	//an easy way to create simple class
	//will automaticaly set a proxy
	//name and superClass may be omit
	class (name, superClass, proto) {
		if (typeof name === 'object') {
			proto = name
			name = 'Anonymous'
			superClass = null
		}
		else if (typeof superClass === 'object') {
			proto = superClass

			if (typeof name === 'function') {
				superClass = name
				name = 'Anonymous'
			}
		}

		if (!proto.init) {
			throw new Error('"init" method of "FF.class" must exist')
		}

		let NewClass = new Function(`
			return function ${name} (...args) {
				let proxy = FF.getProxy(this)
				this.init.call(proxy, ...args)
				return proxy
			}
		`)()

		if (superClass) {
			proto.__proto__ = superClass.prototype
		}

		NewClass.prototype = proto

		return NewClass
	},
})



//shared with all the Components
const ComponentSharedMethods = {

	//auto merge template, directives, fitlers, not merge mixins
	registerComponent (name, superName, options = {}) {
		if (typeof superName === 'object') {
			options = superName
			superName = ''
		}

		FF._registerComponentAt(this.prototype, name, superName, options)
	},


	getComponent (name) {
		return this.prototype.components[name]
	},


	newComponent (name, options) {
		if (typeof name === 'object') {
			options = name
			name = ''
		}
		else {
			options = options || {}
		}

		if (typeof options.el === 'string') {
			options.el = dom.createFromHTML(options.el)
		}

		if (name === '' && options.el) {
			name = compiler.getComponentName(this.prototype, options.el)
		}

		let Com = this.getComponent(name)

		if (!Com) {
			throw new Error(`"${name}" is not a registered component`)
		}

		return new Com(options)
	},


	newInnerComponent (name, options) {
		if (typeof name === 'object') {
			options = name
			name = ''
		}
		else {
			options = options || {}
		}

		if (!options.el) {
			throw new Error(`"options.el" must be provided when using "newInnerComponent"`)
		}
		else if (typeof options.el === 'string') {
			options.el = dom.createFromHTML(options.el)
		}

		if (name === '') {
			name = compiler.getComponentName(this.prototype, options.el)
		}

		let Com = name ? this.getComponent(name) : FF

		if (!Com) {
			throw new Error(`"${name}" is not a registered component`)
		}

		return new Com(options)
	},


	registerDirective (name, options) {
		options.name = name
		options.priority = options.priority || 0

		this.prototype.directives[name] = options
	},


	//can bind an aditional number or string argument
	registerFilter (name, fn) {
		this.prototype.filters[name] = fn
	},


	registerTransition (name, options) {
		this.prototype.transitions[name] = options
	},
}

ff.assign(FF, ComponentSharedMethods)



//FF instance
FF.prototype = {

	__proto__: ff.Emitter.prototype,

	components: {},

	directives: {},

	filters: {},

	transitions: {},

	//include objects which has some perperties and methods, and onCreated and onReady...
	//the mixin objects will be assigned only if there is no same property exists
	mixins: null,

	onCreated: null,

	// onCompile: null,

	onReady: null,

	onDestroy: null,

	//when no el property specified, create el from template, and then insert into this
	appendTo: null,


	//inner properties
	_inherit: false,

	//in f-if inner region, we still want to use outer scope
	_isCreatedByIf: false,

	_isCreatedByComponentDir: false,

	_linkFn: null,

	_templateLinkEl: null,

	_templateLinkFn: null,

	_templateHasSlots: null,


	_init (options) {
		if (options) {
			FF._initOptions(options, this, false)
			ff.assign(this, options)
		}

		this._initEvents(this)
		this._initMixins()

		this._readScope = this	//skip if
		this._writeScope = this	//skip all inherited component
		this._inactiveState = 0	//0:normal, 1:inherit, 2:self inactive
		this._destroyed = false
		this._watchers = []
		this._directives = []
		this._children = []
		this.refs = {}
		this.slots = {}

		if (this._parent) {
			this._parent._children.push(this)
		}
		else {
			FF.topVMs.push(this)
		}

		if (this.el) {
			this.el[vmSymbol] = this
		}

		//data and properties prepared here
		this.emit('created')

		//el created, and directives binded here
		if (this.el || this.template) {
			this._initEl()
		}
		
		if (!this._isCreatedByComponentDir) {
			this._onChildrenLinked()
		}
	},


	_initWhenInherit (options) {
		options.el = options.el || null
		options.template = options.template || null
		options.appendTo = options.appendTo || null

		ff.assign(this, options)

		//never use a proxy as __proto__, many bugs will appear
		this.__proto__ = this._parent._readScope[targetSymbol]

		if (!this._isCreatedByIf) {
			this._readScope = this
		}

		this._isCreatedByComponentDir = false
		this._inactiveState = 0
		this._destroyed = false
		this._watchers = []
		this._directives = []
		this._children = []
		this._parent._children.push(this)

		if (this.el) {
			this.el[vmSymbol] = this
		}

		this.emit('created')

		this._initEl()

		if (!this._isCreatedByComponentDir) {
			this._onChildrenLinked()
		}
	},


	_initEvents (options) {
		if (options.onCreated) {
			this.on('created', options.onCreated, this[proxySymbol])
		}

		if (options.onReady) {
			this.on('ready', options.onReady, this[proxySymbol])
		}

		if (options.onDestroy) {
			this.on('destroy', options.onDestroy, this[proxySymbol])
		}
	},


	_initMixins () {
		if (this.mixins) {
			for (let mixinOptions of this.mixins) {
				this._initEvents(mixinOptions)
				ff.assignIf(this, mixinOptions)
			}
		}
	},


	_initEl () {
		let {el} = this
		let temEl

		if (el && this.appendTo) {
			let appendTo = typeof this.appendTo === 'function' ? this.appendTo() : this.appendTo
			appendTo.append(el)
		}

		//top vm
		if (el && !this._parent) {
			let linkSelfFn = this._compile(el, true)
			linkSelfFn.call(this, el)
		}

		//been passed a _linkFn, like f-if, f-for, or <component inner>
		if (el && this._linkFn) {
			//for <component f-if>, vmSymbol should pointer to the component, not the if VM.
			el[vmSymbol] = this
			this.el = el = this._linkFn(el)
		}

		//sometimes, we the current vm will be used according to refs in its out content scope
		if (this.template) {
			this._compileTemplate()

			if (el) {
				this._oldEl = el
			}

			this.el = this._createElFromTemplate()
		}
	},


	_compileTemplate () {
		let proto = this._getNearestTemplatedProto()

		if (!proto.hasOwnProperty('_templateLinkEl')) {
			let linkEl = proto._templateLinkEl = this._newTemplateEl()

			// if (this.onCompile) {
			// 	this.onCompile(linkEl)
			// }

			proto._templateHasSlots = linkEl.localName === 'slot' || !!linkEl.querySelector('slot')	//slot may be removed after compiled
			proto._templateLinkFn = this._compile(linkEl)
		}
	},


	_getNearestTemplatedProto () {
		let proto = this

		do {
			if (proto.hasOwnProperty('template')) {
				return proto
			}
			else {
				proto = proto.__proto__
			}
		}
		while (proto)
	},


	_newTemplateEl () {
		let {template} = this
		let temStr

		if (typeof template === 'string') {
			temStr = template
		}
		else {
			let main = template.main

			if (typeof main !== 'string') {
				throw '"main" property must exist when template is an object'
			}

			temStr = this._formatTemplate(main, template, 10)
		}

		return dom.createFromHTML(temStr)
	},


	_formatTemplate (str, templates, maxDeep) {
		if (maxDeep === 0) {
			return ''
		}

		return str.replace(/\{\{[\s\S]+?\}\}|\{([a-zA-Z_]+)\}/g, (m0, name) => {
			if (!name) {
				return m0
			}

			let subStr = templates[name]

			if (typeof subStr === 'undefined') {
				return m0
			}

			return this._formatTemplate(subStr, templates, maxDeep - 1)
		})
	},


	_createElFromTemplate () {
		let linkEl = this._templateLinkEl
		let temEl = linkEl.cloneNode(true)

		temEl[vmSymbol] = this

		return temEl
	},


	_onChildrenLinked () {
		if (this.template) {
			this._linkTemplate()
		}

		this.emit('ready')
	},


	_extractSlots (el) {
		let {slots} = this

		for (let insertEl of [...el.querySelectorAll('[slot]')]) {
			let name = insertEl.getAttribute('slot')
			if (name) {
				insertEl.removeAttribute('slot')
				insertEl.remove()

				let theSlot = slots[name]
				if (!theSlot) {
					theSlot = slots[name] = []
				}

				theSlot.push(insertEl)
			}
		}

		el.normalize()

		if (el.childNodes.length > 0) {
			slots['rest'] = [...el.childNodes]
		}
	},


	_copyAttributes (from, to) {
		for (let i = 0, len = from.attributes.length; i < len; i++) {
			let {name, value} = from.attributes[i]
			let mergedValue = value
			let toValue = to.getAttribute(name)

			if ((name === 'class' || name === 'style') && toValue) {
				if (name === 'style') {
					mergedValue += /;\s*$/.test(value) ? '' : '; '
				}
				else if (name === 'class') {
					mergedValue += /\s+$/.test(value) ? '' : ' '
				}

				mergedValue += toValue
			}

			to.setAttribute(name, mergedValue)
		}
	},


	_fillSlots (temEl) {
		let {slots} = this
		let refs = this.refs
		let unnamedSlots = []
		let slotEls = temEl.localName === 'slot' ? [temEl] : temEl.querySelectorAll('slot')

		for (let slotEl of slotEls) {
			let name = slotEl.getAttribute('name')

			if (name) {
				slotEl.removeAttribute('name')

				let insertEls = slots[name]

				if (insertEls) {
					if (insertEls.length === 1 && insertEls[0].nodeType === 1) {
						this._copyAttributes(slotEl, insertEls[0])
						refs[name] = insertEls[0]
					}

					slotEl.replaceWith(...insertEls)
				}
				else {
					let {childNodes} = slotEl
					if (childNodes.length > 0) {
						slots[name] = [...childNodes]
						slotEl.replaceWith(...childNodes)
					}
					else {
						slotEl.remove()
					}
				}
			}
			else {
				unnamedSlots.push(slotEl)
			}
		}

		if (unnamedSlots.length > 1) {
			throw new Error('only one unnamed slot is allowed')
		}

		for (let slotEl of unnamedSlots) {
			let restEls = slots['rest']
			if (restEls) {
				slotEl.replaceWith(...restEls)
			}
			else {
				let {childNodes} = slotEl
				if (childNodes.length > 0) {
					slots[name] = [...childNodes]
					slotEl.replaceWith(...childNodes)
				}
				else {
					slotEl.remove()
				}
			}
		}
	},


	_linkTemplate () {
		let oldEl = this._oldEl
		let temEl = this.el
		let linkEl = this._templateLinkEl
		let linkFn = this._templateLinkFn
		let hasSlots = this._templateHasSlots

		if (oldEl) {
			if (hasSlots) {
				this._extractSlots(oldEl)
				this._cleanUselessSlotsInner(temEl)
			}

			this._copyAttributes(oldEl, temEl)
			oldEl.replaceWith(temEl)
		}
		else if (this.appendTo) {
			let appendTo = typeof this.appendTo === 'function' ? this.appendTo() : this.appendTo
			appendTo.append(temEl)
		}

		linkFn.call(this, temEl)

		if (oldEl) {
			this._fillSlots(temEl)
		}
	},


	_cleanUselessSlotsInner (temEl) {
		let {slots} = this

		for (let slotEl of temEl.querySelectorAll('slot')) {
			let name = slotEl.getAttribute('name') || 'rest'

			if (slots[name] && slotEl.childNodes.length) {
				[...slotEl.childNodes].forEach(el => el.remove())
				slotEl[skipLinkingSymbol] = true
			}
		}
	},


	_compile (el, compilingComponent) {
		return compiler.compile(this, el, compilingComponent)
	},


	newComponent (name, options) {
		let target = this[targetSymbol]

		if (typeof name === 'object') {
			options = name
			name = ''
		}
		else {
			options = options || {}
		}

		if (options.el && typeof options.el === 'string') {
			options.el = dom.createFromHTML(options.el)
		}

		if (name === '' && options.el) {
			name = compiler.getComponentName(target, options.el)
		}

		return target._newComponent(name, options)
	},


	_newComponent (name, options) {
		let target = this[targetSymbol]
		let Com = name ? target.components[name] : FF

		if (!Com) {
			throw new Error(`"${name}" is not a registered component`)
		}

		options._parent = target[targetSymbol]
		
		return new Com(options)
	},


	newInheritedComponent (options = {}) {
		let target = this[targetSymbol]

		if (!options.el) {
			throw new Error(`"options.el" must be provided when using "newInheritedComponent"`)
		}
		else if (typeof options.el === 'string') {
			options.el = dom.createFromHTML(options.el)
		}

		options._inherit = true
		options._parent = target[targetSymbol]
		options._linkFn = options._linkFn || target._compile(options.el)

		return new FF(options)
	},


	newInnerComponent (name, options) {
		let target = this[targetSymbol]

		if (typeof name === 'object') {
			options = name
			name = ''
		}
		else {
			options = options || {}
		}

		if (!options.el) {
			throw new Error(`"options.el" must be provided when using "newInnerComponent"`)
		}
		else if (typeof options.el === 'string') {
			options.el = dom.createFromHTML(options.el)
		}

		if (name === '') {
			name = compiler.getComponentName(target, options.el)
		}

		let Com = name ? target.components[name] : FF

		if (!Com) {
			throw new Error(`"${name}" is not a registered component`)
		}

		options._linkFn = target._compile(options.el, true)
		options._parent = target
		
		return new Com(options)
	},


	addDirective (el, name, dir = {}) {
		let target = this[targetSymbol]

		if (typeof dir === 'string') {
			dir = {exp: dir}
		}

		let getter = lexer.compileReader(dir.exp)

		dir.__proto__ = target.directives[name]
		dir.name = name
		dir.el = el

		compiler.bindDirective(target, dir, getter)

		return dir
	},


	watch (exp, handler, immediate) {
		let target = this[targetSymbol]
		let getter = null

		if (typeof exp === 'function') {
			getter = exp
			exp = exp.toString()
		}

		let watcher = new Watcher({
			vm: target[targetSymbol],
			exp,
			getter,
			handler,
		}, false)

		target._watchers.push(watcher)

		if (immediate) {
			handler.call(target, watcher.value)
		}

		return watcher
	},


	watchOnce (exp, handler, immediate) {
		let target = this[targetSymbol]

		let wrappedHandler = function (...args) {
			target.unwatch(watcher)
			handler.apply(target, args)
		}

		let watcher = target.watch(exp, wrappedHandler, immediate)
	},


	watchUntil (exp, handler) {
		let target = this[targetSymbol]

		let wrappedHandler = function (value, oldValue) {
			if (value) {
				target.unwatch(watcher)
				handler.call(target, value, oldValue)
			}
		}

		let watcher = target.watch(exp, wrappedHandler)
	},


	unwatch (watcher) {
		let target = this[targetSymbol]
		let index = target._watchers.findIndex(v => v === watcher)

		if (index > -1) {
			target._watchers[index].destroy()
			target._watchers.splice(index, 1)
		}
	},


	digest () {
		let target = this[targetSymbol]

		if (target._inactiveState || target._destroyed) {
			return
		}

		for (let watcher of target._watchers) {
			watcher.updateNow(true)
		}

		for (let child of target._children) {
			child.digest()
		}
	},


	_setActive (fromParent = false) {
		let target = this[targetSymbol]

		if (target._inactiveState === 1 || !fromParent) {
			target._inactiveState = 0

			for (let child of target._children) {
				child._setActive(true)
			}

			target.emit('active')
		}
	},


	_setInactive (fromParent = false) {
		let target = this[targetSymbol]

		if (target._inactiveState === 0) {
			target._inactiveState = fromParent ? 1 : 2

			for (let child of target._children) {
				child._setInactive(true)
			}

			target.emit('inactive')
		}
	},


	closest (name) {
		if (!this.el.parentNode) {
			return null
		}

		let selector

		if (name) {
			let names = name.split(/\s*,\s*/)
			selector = names.map(name => `[is=${name}]`).join(',')
		}
		else {
			selector = '[is]'
		}

		let closestEl = this.el.parentNode.closest(selector)
		return closestEl ? FF.getVM(closestEl) : null
	},


	destroy (fromParent = false) {
		let target = this[targetSymbol]

		if (target._destroyed) {
			return
		}
		
		for (let dir of target._directives) {
			if (dir.unbind) {
				dir.unbind()
			}
		}

		for (let watcher of target._watchers) {
			watcher.destroy()
		}

		target.el.remove()

		if (!target._parent) {
			ff.remove(FF.topVMs, target)
		}
		else if (!fromParent) {
			target._parent._children.remove(target)
		}

		for (let child of target._children) {
			child.destroy(true)
		}

		target._destroyed = true
		target.emit('destroy')
	},
}



/*
directives priorities:
	1000 - pre
	 900 - for
	 800 - if
	 700 - component binds
	 600 - component
	 500 - element binds
	 500 - model
	   0 - on
	   0 - element related directives
*/

FF.registerDirective('text', {

	update (value) {
		let {el} = this
		el.textContent = util.isNullOrUndefined(value) ? '' : String(value)
	},
})


FF.registerDirective('html', {

	update (value) {
		let {el} = this
		let newValue = util.isNullOrUndefined(value) ? '' : value

		if (el.isContentEditable) {
			if (newValue !== el.innerHTML) {
				el.innerHTML = newValue
			}
		}
		else {
			el.innerHTML = newValue
		}
	},
})


FF.registerDirective('enable', {

	update (value) {
		let {el} = this

		if (value) {
			el.removeAttribute('disabled')
		}
		else {
			el.setAttribute('disabled', '')
		}
	},
})


FF.registerDirective('disable', {

	update (value) {
		let {el} = this

		if (value) {
			el.setAttribute('disabled', '')
		}
		else {
			el.removeAttribute('disabled')
		}
	},
})


FF.registerDirective('ref', {

	isLiteral: true,

	update (refs) {
		let {el, vm} = this

		for (let ref of refs.split(' ')) {
			if (ref) {
				vm.refs[ref] = el
			}
		}
	}
})


FF.registerDirective('cloak', {
	isLiteral: true
})



//supports mods: .prevent, .stop, .capture, .self, .once, .native
FF.registerDirective('on', {

	//priority must behind component
	
	isListener: true,

	mods: [],

	NOT_FILTER_MODS: ['native', 'capture', 'self', 'once', 'prevent', 'stop'],


	onCompile () {
		let filters = []
		let {mods, NOT_FILTER_MODS} = this

		for (let i = 0; i < mods.length; i++) {
			let mod = mods[i]

			if (!NOT_FILTER_MODS.includes(mod)) {
				mods.splice(i--, 1)
				filters.push(mod)
			}
		}

		this.filters = filters.length ? '.' + filters.join('.') : ''
	},


	update (newHandler, oldHandler) {
		let {el, vm, prop, mods} = this
		let com = el[vmSymbol]
		let isComEvent = com && com !== vm[targetSymbol] && !mods.includes('native')

		if (isComEvent) {
			if (oldHandler) {
				com.off(prop, oldHandler, vm)
			}

			if (newHandler) {
				com.on(prop, newHandler, vm)
			}
		}
		else {
			let eventName = prop + this.filters
			let capture = mods.includes('capture')
			let passive = mods.includes('passive')
			let eventOptions = {capture, passive}

			if (oldHandler) {
				dom.off(el, eventName, oldHandler, eventOptions)
			}

			if (newHandler) {
				newHandler = this.wrapHandler(el, newHandler)
				dom.on(el, eventName, newHandler, eventOptions)
			}
		}

		this.handler = newHandler
	},


	wrapHandler (el, handler) {
		let {prop, mods, vm} = this

		let wrappedHandler = (e) => {
			if (mods.includes('self') && e.target !== el) {
				return
			}

			if (mods.includes('once')) {
				dom.off(el, prop, wrappedHandler, mods.includes('capture'))
			}

			if (mods.includes('prevent')) {
				e.preventDefault()
			}

			if (mods.includes('stop')) {
				e.stopPropagation()
			}

			handler.call(vm, e)
		}

		return wrappedHandler
	},
})



//:src="url", cant use 
//:class="'class1 class2'", :class="[class1, class2]", :class="{class1: value1, class2: value2}", :class.class1="value1"
//:style same as :class, otherwise :style.name.px="value"
//:attr="{name: value}", :attr.name="value"
//not support :="{a, b}", but support :="obj"
//use .camel to support properties like viewBox
//use .px to add px as unit, .percentage to add %, .url to add url()
FF.registerDirective('bind', {

	priority: 400,

	prop: '',

	mods: [],

	onCompile () {
		let {prop, mods} = this

		if (!['attr', 'class', 'style'].includes(prop)) {
			this.prop = util.toCamerCase(prop)
		}

		if (mods.indexOf('camel') > 0) {
			mods[0] = util.toCamerCase(mods[0])
		}
	},


	update (newValue, oldValue) {
		let {el, prop} = this

		if (prop === 'attr') {
			this.updateAttr(newValue, oldValue)
		}
		else if (prop === 'class') {
			this.updateClass(newValue, oldValue)
		}
		else if (prop === 'style') {
			this.updateStyle(newValue, oldValue)
		}
		else {
			newValue = util.isNullOrUndefined(newValue) ? '' : newValue

			//may update value of textarea to same value, which will reset insert postition to start
			if (el[prop] !== newValue) {
				el[prop] = newValue
			}
		}
	},


	updateAttr (newValue, oldValue) {
		let {mods} = this
		let mod0 = mods[0]

		if (mod0) {
			if ([false, undefined, null].includes(newValue)) {
				this.removeAttribute(mod0)
			}
			else {
				this.setAttribute(mod0, newValue)
			}
		}
		else {
			let {add, remove} = this.compare(oldValue, newValue)

			if (remove.length > 0) {
				for (let attr of remove) {
					this.removeAttribute(attr)
				}
			}
			
			if (add.length > 0) {
				for (let attr of add) {
					this.setAttribute(attr, newValue[attr])
				}
			}
		}
	},


	setAttribute (name, value) {
		let {el} = this

		if (name.startsWith('xlink:')) {
			el.setAttributeNS('http://www.w3.org/1999/xlink', name, value)
		}
		else {
			el.setAttribute(name, value)
		}
	},


	removeAttribute (name) {
		let {el} = this

		if (name.startsWith('xlink:')) {
			el.removeAttributeNS('http://www.w3.org/1999/xlink', name)
		}
		else {
			el.removeAttribute(name)
		}
	},


	compare (oldObj = {}, newObj = {}) {
		let add = []
		let remove = []
		let falseValues = [false, undefined, null]

		for (let key in oldObj) {
			let oldValue = oldObj[key]
			let newValue = newObj[key]

			if (!falseValues.includes(oldValue) && falseValues.includes(newValue)) {
				remove.push(key)
			}
		}

		for (let key in newObj) {
			let oldValue = oldObj[key]
			let newValue = newObj[key]

			if (oldValue !== newValue) {
				add.push(key)
			}
		}

		return {
			add,
			remove,
		}
	},


	updateClass (newValue, oldValue) {
		let oldObj = this.parseClass(oldValue)
		let newObj = this.parseClass(newValue)
		let {add, remove} = this.compare(oldObj, newObj)

		if (remove.length > 0) {
			dom.removeClass(this.el, ...remove)
		}
		
		if (add.length > 0) {
			dom.addClass(this.el, ...add)
		}
	},


	parseClass (value) {
		let mod0 = this.mods[0]
		let obj = {}

		if (mod0) {
			if (value) {
				obj[mod0] = true
			}
		}
		else if (Array.isArray(value)) {
			for (let item of value) {
				if (typeof item === 'object') {
					for (let key in item) {
						obj[key] = !!item[key]
					}
				}
				else {
					for (let cls of String(item).split(/\s+/)) {
						obj[cls] = true
					}
				}
			}
		}
		else if (value && typeof value === 'object') {
			for (let key in value) {
				obj[key] = !!value[key]
			}
		}
		else if (typeof value === 'string') {
			if (/\s/.test(value)) {
				for (let cls of value.split(/\s+/)) {
					obj[cls] = true
				}
			}
			else if (value) {
				obj[value] = true
			}
		}

		return obj
	},


	updateStyle (newValue, oldValue) {
		let oldObj = this.parseStyle(oldValue)
		let newObj = this.parseStyle(newValue)
		let {add, remove} = this.compare(oldObj, newObj)
		let willAddPX = this.mods.includes('px')
		let willAddPercentage = this.mods.includes('percent')
		let willAddURL = this.mods.includes('url')

		if (add.length + remove.length > 0) {
			let obj = {}

			for (let key of remove) {
				obj[key] = ''
			}

			for (let key of add) {
				let value = newObj[key]

				if (util.isNullOrUndefined(value)) {
					value = ''
				}
				else if (willAddPX) {
					value = value + 'px'
				}
				else if (willAddPercentage) {
					value = value + '%'
				}
				else if (willAddURL) {
					value = 'url("' + value + '")'
				}

				obj[key] = value
			}

			dom.setCSS(this.el, obj)
		}
	},


	parseStyle (value) {
		let mod0 = this.mods[0]
		let obj = {}

		if (mod0) {
			if (!util.isNullOrUndefined(value)) {
				obj[mod0] = value
			}
		}
		else if (Array.isArray(value)) {
			for (let item of value) {
				if (typeof item === 'object') {
					ff.assign(obj, item)
				}
				else {
					for (let style of String(item).split(/\s*;\s*/)) {
						let [k, v] = style.split(/\s*:\s*/)
						if (k && v) {
							obj[k] = v
						}
					}
				}
			}
		}
		else if (util.isObject(value)) {
			obj = value
		}
		else if (value && !util.isNullOrUndefined(value)) {
			for (let style of String(value).split(/\s*;\s*/)) {
				let [k, v] = style.split(/\s*:\s*/)
				if (k && v) {
					obj[k] = v
				}
			}
		}

		return obj
	},
})



//for component data binding
FF.registerDirective('com-bind', {

	priority: 600,

	prop: '',


	onCompile (el) {
		this.prop = util.toCamerCase(this.prop)
	},


	bind () {
		this.com = null
	},


	bindCom (com) {
		if (this.vm === com) {
			throw new Error(`"${this.nodeName}=${this.exp}" must bind to root element of another component`)
		}

		this.com = com
	},


	update (value) {
		let {com, prop} = this

		if (prop) {
			com[prop] = value
		}
		else if (value && typeof value === 'object') {
			ff.assign(com, value)
		}
	},
})



//for component data binding
FF.registerDirective('out', {

	priority: 300,	//lower than "bind", higher than "on"

	isLiteral: true,

	prop: '',


	onCompile (el) {
		this.prop = util.toCamerCase(this.prop)
	},


	bind () {
		this.com = null
	},


	update (exp) {
		let {vm, prop} = this
		let com = this.el[vmSymbol]

		if (!com || vm === com) {
			throw new Error(`"${this.nodeName}=${this.exp}" must bind to root element of another component`)
		}

		com.watch(exp, (value) => {
			if (prop) {
				vm[prop] = value
			}
			else {
				ff.assign(vm, value)
			}
		}, true)
	},
})



//supports mods: .lazy, .number
FF.registerDirective('model', {

	priority: 400,

	mods: [],


	onCompile (el) {
		let {type, localName} = el
		let isFormField = ['input', 'select', 'textarea'].includes(localName)
		let isLazy = this.mods.includes('lazy')

		this.isCheckbox = localName === 'input' && type === 'checkbox'
		this.isBoolValue = localName === 'input' && (type === 'checkbox' || type === 'radio')
		this.isMultiSelect = localName === 'select' && el.multiple
		this.optionValue = this.isBoolValue ? el.getAttribute('value') || '' : ''

		if (this.isBoolValue) {
			this.prop = 'checked'
			this.eventName = 'change'
		}
		else if (isFormField) {
			this.prop = 'value'
			this.eventName = isLazy ? 'change' : 'input'
		}
		else {
			this.prop = 'innerHTML'
			this.eventName = isLazy ? 'blur' : 'input'	//div@contendeditable cant trigger change event
		}
	},


	bind () {
		let {el, eventName} = this

		this.locked = false
		dom.on(el, eventName, this.onInputOrChange, this)

		//we just want to makesure the value equals to the value of final state
		if (eventName === 'input') {
			let lazyEventName = this.prop === 'innerHTML' ? 'blur' : 'change'
			dom.on(el, lazyEventName, this.onInputOrChange, this)
		}
	},


	onInputOrChange (e) {
		let inputValue = this.el[this.prop]

		if (this.isBoolValue) {
			this.setBoolValue(inputValue)
		}
		else {
			this.setInputValue(inputValue)
		}

		this.locked = true
		queues.pushInnerTask(() => {
			this.locked = false

			//write value back to input
			if (e.type === 'change') {
				this.update(this.watcher.value)
			}
		})
	},


	setBoolValue (inputValue) {
		let {vm, isCheckbox, optionValue, watcher} = this
		let value = this.watcher.value
		let isInCheckboxGroup = isCheckbox && Array.isArray(value)

		if (isInCheckboxGroup) {
			if (inputValue) {
				ff.add(value, optionValue)
			}
			else {
				ff.remove(value, optionValue)
			}
		}
		else {
			watcher.set(inputValue ? optionValue || true : false)
		}
	},


	setInputValue (inputValue) {
		let {el, vm, watcher} = this
		let isNumber = this.mods.includes('number')

		if (this.isMultiSelect) {
			let value = Array.from(el.options).filter(o => o.selected).map(o => o.value)

			if (isNumber) {
				value = value.map(Number)
			}

			watcher.set(value)
		}
		else {
			if (isNumber) {
				let numValue = Number(inputValue)
				watcher.set(numValue)
			}
			else {
				watcher.set(inputValue)
			}
		}
	},


	update (value) {
		if (this.locked) {
			return
		}

		if (this.isBoolValue) {
			this.updateBoolValue(value)
		}
		else {
			this.updateInputValue(value)
		}
	},


	updateBoolValue (value) {
		let {el, prop, isCheckbox, optionValue} = this
		let isInCheckboxGroup = isCheckbox && Array.isArray(value)

		if (isInCheckboxGroup) {
			el[prop] = value.includes(optionValue)
		}
		else {
			el[prop] = optionValue ? value === optionValue : !!value
		}
	},


	updateInputValue (value) {
		let {el, prop, isMultiSelect} = this

		if (isMultiSelect && !Array.isArray(value)) {
			throw new Error('"model" directive of select[multiple] requires an array as value')
		}

		if (isMultiSelect) {
			for (let option of el.options) {
				option.selected = value.includes(option.value)
			}
		}
		else {
			el[prop] = util.isNullOrUndefined(value) ? '' : value
		}
	},
})



//for component data binding
FF.registerDirective('com-model', {

	priority: 600,

	prop: 'value',

	mods: [],


	bind () {
		this.com = null
	},


	bindCom (com) {
		if (this.vm === com) {
			throw new Error(`"${this.nodeName}=${this.exp}" must bind to root element of another component`)
		}

		this.com = com
		com.on('change', this.onChange, this)
	},


	update (value) {
		let {prop, com} = this

		if (prop) {
			com[prop] = value
		}
		else if (value && typeof value === 'object') {
			ff.assign(com, value)
		}
	},


	onChange (value) {
		let isNumber = this.mods.includes('number')
		if (isNumber) {
			value = Number(value)
		}

		this.watcher.set(value)
	},
})



//use let to create a scoped variable
//strongly suggest you only use it in "for" directive, or root el of component, because its scope is really confusing
//especially on a <component> element(without inner), it never defines any variable inside component, but outside it
FF.registerDirective('let', {

	priority: 700,	//lower than component


	onCompile () {
		let {prop} = this

		if (!prop) {
			throw new Error('"let" directive must specify a property')
		}

		this.prop = util.toCamerCase(prop)
	},


	update (value) {
		let {vm, prop} = this
		vm[prop] = value
	},
})



//<componentName></componentName>
//<component is="name">
//<component :is="dynamicName">, beware, it doesn't support getting options from attributes
FF.registerDirective('component', {

	priority: 500,	//higher than binds

	isLiteral: true,

	inner: false,

	binds: null,

	ref: '',


	onCompile (el, vm) {
		let Com = vm.components[this.exp]

		if (this.inner) {
			this.linkEl = el
			this.linkFn = compiler.compile(Com.prototype, el, true)
		}

		this.optionsFromAttributes = this.getOptionsFromAttributes(el, Com)
	},


	getOptionsFromAttributes (el, Com) {
		let options = {}
		let hasAnyOptions = false

		if (Com) {
			let proto = Com.prototype

			for (let i = 0, len = el.attributes.length; i < len; i++) {
				let {name, value} = el.attributes[i]
				let property = util.toCamerCase(name)
				let protoType = typeof proto[property]

				if (protoType !== 'undefined') {
					if (protoType === 'number') {
						options[property] = Number(value)
					}
					else if (protoType === 'boolean') {
						options[property] = true
					}
					else {
						options[property] = value || ''
					}

					hasAnyOptions = true
				}
			}
		}

		return hasAnyOptions ? options : null
	},


	bind () {
		this.com = null
	},


	update (name) {
		let {vm, binds} = this
		let com = this.com = this.createCom(name)

		for (let dir of binds) {
			dir.bindCom(com)
		}

		if (this.ref) {
			vm.refs[this.ref] = com
		}
	},


	createCom (name) {
		let {el, vm} = this

		let options = {
			_isCreatedByComponentDir: true,
		}
		
		if (this.inner) {
			let {linkEl, linkFn} = this
			let newEl = options.el = linkEl.cloneNode(true)
			el.replaceWith(newEl)

			options.el = newEl
			options._linkFn = linkFn
		}
		else {
			options.el = el
		}

		ff.assign(options, this.optionsFromAttributes)

		for (let dir of this.binds) {
			let {prop, watcher} = dir
			let value = watcher.value

			if (prop) {
				options[prop] = value
			}
			else if (value && typeof value === 'object') {
				ff.assign(options, value)
			}
		}

		return vm._newComponent(name, options)
	},
})



/*
"if" will cause it's sub directives and watchers not been linked when no need
but there is a bug here, consider we have a checkbox:value=true and f-if="value":

                       OUTER  WATCHER  INNER
linked                 true   true     true
inner change           true   true     false
trigger change event   false  true     false  --locked by f-if
outer changed to true  true   true     false  --watcher compare true=true, not update inner, bug happens

add a updateEvenVMInactive property to watcher to solve it
*/
FF.registerDirective('if', {

	priority: 800,

	isTerminal: true,

	mods: [],


	onCompile (el) {
		let exps = [this.exp]

		this.exps = exps
		this.linkEls = [el]
		this.linkFns = {}
		this.hasElse = false	//used for compiling process

		let nextEl = el.nextElementSibling

		while (nextEl) {
			if (nextEl.hasAttribute('f-else-if')) {
				exps.push(nextEl.getAttribute('f-else-if'))
				this.linkEls.push(nextEl)
			}
			else if (nextEl.hasAttribute('f-else')) {
				this.linkEls.push(nextEl)
				this.hasElse = true
				break
			}
			else {
				break
			}

			nextEl = nextEl.nextElementSibling
		}
	},


	bind () {
		let {el, exp} = this

		this.coms = {}
		this.index = -1

		this.startMark = document.createComment('if ' + exp)
		el.before(this.startMark)
		el.remove()
	},


	update (newIndex, oldIndex) {
		let {vm, coms, startMark, linkEls, linkFns} = this

		if (oldIndex > -1) {
			let oldCom = coms[oldIndex]

			if (oldCom) {
				oldCom._setInactive()

				let oldEl = oldCom.el
				let transition = oldEl[transitionSymbol]

				let onTransitionEnd = (finish) => {
					if (finish) {
						oldEl.setAttribute('f-cloak', '')
					}
				}

				if (transition && oldIndex !== undefined) {
					transition.leaveAfterUpdated(onTransitionEnd)
				}
				else {
					oldEl.setAttribute('f-cloak', '')
				}
			}
		}

		if (newIndex > -1) {
			let newCom = coms[newIndex]

			if (newCom) {
				newCom.el.removeAttribute('f-cloak')
				newCom._setActive()
				newCom.digest()
			}
			else {
				let linkEl = linkEls[newIndex]
				let linkFn = linkFns[newIndex]
				if (!linkFn) {
					linkFn = linkFns[newIndex] = vm._compile(linkEl)
				}

				let newEl = linkEl.cloneNode(true)
				startMark.after(newEl)

				let options = {
					el: newEl,
					_linkFn: linkFn,
					_isCreatedByIf: true,
				}

				newCom = coms[newIndex] = vm.newInheritedComponent(options, true)
			}

			let transition = newCom.el[transitionSymbol]
			if (transition && oldIndex !== undefined) {
				transition.enterAfterUpdated()
			}
		}
	},
})


FF.registerDirective('else-if', {
	isTerminal: true,
	priority: 1000,
})


FF.registerDirective('else', {
	isTerminal: true,
	priority: 1000,
})



//f-for="key in data"
//f-for="key, value in data"
//f-for=", value in data"
//f-for="key, value, index in data"
//f-for="value of data"
//f-for="a = b to c"
//f-for="a = 0 to 5 step 1"	//0, 1, 2, 3, 4
//f-for="a = 5 to 0 step 1"	//5, 4, 3, 2, 1
//datas should be both value type or both object type
//data should not has duplicate values or objects
//when animation been played
//	1. No new item (all caches hit) and removed some items, play leave animation
//	2. Add one item and not first time rendering, play enter animation
FF.registerDirective('for', {

	priority: 900,

	isTerminal: true,

	loop: null,

	ref: '',


	onCompile (el, vm) {
		this.linkEl = el
		this.linkFn = vm._compile(el)

		//global properties which shared by all the f-for directive which use same template
		//so we can share com cache across vms
		//we delay com creating, and collect removed coms, and create vms using the cache later
		this.isUpdatingDirs = false
		this.updatingDirs = []
		this.willCreate = []
		this.willRemove = []
	},


	willUpdateDir (dir) {
		this.updatingDirs.push(dir)

		if (!this.isUpdatingDirs) {
			queues.pushInnerTask(() => {
				this.flushDefreredUpdating()
			})

			this.isUpdatingDirs = true
		}
	},


	flushDefreredUpdating () {
		let {willCreate, willRemove, updatingDirs} = this

		while (willCreate.length > 0) {
			let {dir, prevEl, value, key, index, isFirstTimeRendering} = willCreate.shift()
			let com = dir.createCom(prevEl, value, key, index, isFirstTimeRendering)

			let nextOptions = willCreate[0]
			if (nextOptions && !nextOptions.prevEl) {
				nextOptions.prevEl = com.el
			}
		}

		while (willRemove.length > 0) {
			let {dir, com} = willRemove.shift()
			dir.removeCom(com)
		}

		while (updatingDirs.length > 0) {
			let dir = updatingDirs.shift()
			dir.isUpdating = false
		}

		this.isUpdatingDirs = false
	},


	//few changes to happen
	removeDirWhichWillUpdate (dir) {
		let {willCreate} = this

		for (let i = willCreate.length - 1; i >= 0; i--) {
			if (willCreate[i].dir === dir) {
				willCreate.splice(i, 1)
			}
		}
	},


	bind () {
		let {el, exp} = this

		this.startMark = document.createComment('for ' + exp)
		this.endMark = document.createComment('end for')
		el.before(this.startMark)
		el.after(this.endMark)
		el.remove()

		this.coms = []
		this.keys = null
		this.isUpdating = false

		if (this.ref) {
			this.vm.refs[this.ref] = this.coms
		}

		this.map = new Map()
	},


	unbind () {
		let data = this.watcher.value

		if (util.isObject(data)) {
			observerManager.unobserveChanges(data, this.onDataChanged, this)
		}
	},


	update (data, oldData) {
		let proto = this.__proto__
		let {type, keyKey, indexKey} = this.loop

		//prepare data
		if (type !== 'to' && data !== oldData) {
			if (util.isObject(oldData)) {
				observerManager.unobserveChanges(oldData, this.onDataChanged, this)
			}

			if (util.isObject(data)) {
				observerManager.observeChanges(data, this.onDataChanged, this)
			}
		}

		let isFirstTimeRendering = oldData === undefined
		let array = this.getLoopArray(data)

		let oldMap = this.map
		let oldComs = this.coms
		let willBeReusedComs = []
		let willBeRemovedComs = []
		let removedElIndexMap = {}
		let matchedCount = 0
		let matchedComSet = new Set()

		for (let [value] of array) {
			//some times it may cause target and proxy not match, but not matter so much
			let com = oldMap.get(value)
			if (com) {
				matchedComSet.add(com)
				matchedCount++
			}
		}

		let needsCreateCount = array.length - matchedCount
		let notMatchedCount = oldComs.length - matchedCount
		let allRemovedCanBeReused = needsCreateCount >= notMatchedCount
		let hasTransition = oldComs.length > 0 && !!oldComs[0].el[transitionSymbol]
		let shouldPlayTransition = false

		if (hasTransition) {
			//may be live rendering, we choose reusing when at most 1/4 parts changed
			if (allRemovedCanBeReused) {
				shouldPlayTransition = notMatchedCount >= 1 && notMatchedCount / array.length < 0.25
			}
			//some removed can not been reused, prefer playing all the transitions
			else {
				shouldPlayTransition = true
			}
		}

		for (let i = 0, needsPlus = 0, len = oldComs.length; i < len; i++) {
			let com = oldComs[i]
			if (!matchedComSet.has(com)) {
				if (!shouldPlayTransition && needsPlus++ < needsCreateCount) {
					willBeReusedComs.push(com)
				}
				else {
					willBeRemovedComs.push(com)
					removedElIndexMap[i] = com.el
				}
			}
		}

		//start updating
		let newMap = this.map = new Map()
		let newComs = this.coms = []
		let {willCreate, willRemove} = proto
		let prevElNeedsToBeCreated = false

		if (this.isUpdating) {
			proto.removeDirWhichWillUpdate(this)
		}

		//regenerate els from old els
		//firstly we get all the element indexs which will be removed
		//then in the loop we try to keep the elements which will be removed in its old position
		//and insert new el or reused el to its right position
		for (let index = 0, oldIndex = 0, len = array.length, prevEl = this.startMark; index < len; index++, oldIndex++) {
			let [value, key] = array[index]

			//value may be same, so we need to check if com for value has been used
			let com = newMap.has(value) ? null : oldMap.get(value)
			let reuseSelf = false
			let reuseOuter = false

			while (removedElIndexMap[oldIndex]) {
				prevEl = removedElIndexMap[oldIndex++]
			}

			if (com) {
				prevEl.after(com.el)

				if (keyKey) {
					com[keyKey] = key
				}

				if (indexKey) {
					com[indexKey] = index
				}
			}
			else {
				if (willBeReusedComs.length > 0) {
					com = willBeReusedComs.shift()
					prevEl.after(com.el)
					this.reuseInnerCom(com, value, key, index)
				}
				else if (willRemove.length > 0 && !shouldPlayTransition) {
					com = willRemove.shift().com
					prevEl.after(com.el)
					this.reuseOuterCom(com, value, key, index)
				}
			}

			if (com) {
				prevEl = com.el
				prevElNeedsToBeCreated = false
				newMap.set(value, com)
				newComs.push(com)
			}
			else {
				willCreate.push({dir: this, prevEl: prevElNeedsToBeCreated ? null : prevEl, value, key, index, isFirstTimeRendering})
				prevElNeedsToBeCreated = true
			}
		}

		proto.willUpdateDir(this)
		this.isUpdating = true

		if (willBeRemovedComs.length > 0) {
			if (shouldPlayTransition) {
				for (let com of willBeRemovedComs) {
					this.removeCom(com)
				}
			}
			else {
				this.willRemoveComs(willBeRemovedComs)
			}
		}
	},


	onDataChanged (target) {
		let data = FF.getTarget(this.watcher.value)

		//arrray data may be partly changed and then been reset
		if (data === target) {
			this.update(data, data)
		}
	},


	getLoopArray (data) {
		let {type} = this.loop

		if (type === 'to') {
			return this.getLoopArrayForTypeTo(data)
		}
		else if (type === 'of') {
			return this.getLoopArrayForTypeOf(data)
		}
		else {
			return this.getLoopArrayForTypeIn(data)
		}
	},


	getLoopArrayForTypeTo (data) {
		let [from, to, step] = data
		let array = []

		if (from <= to) {
			for (let i = from, index = 0; i <= to; i += step) {
				array.push([i, index])
			}
		}
		else {
			for (let i = from, index = 0; i >= to; i -= step) {
				array.push([i, index])
			}
		}

		return array
	},


	getLoopArrayForTypeOf (data) {
		let array = []

		if (data) {
			let index = 0
			for (let value of data) {
				array.push([value, index++])
			}
		}

		return array
	},


	getLoopArrayForTypeIn (data) {
		let array = []

		if (data) {
			if (util.isArray(data)) {
				for (let i = 0, len = data.length; i < len; i++) {
					array.push([data[i], i])
				}
			}
			else {
				this.keys = Object.keys(data)

				for (let key of this.keys) {
					array.push([data[key], key])
				}
			}
		}

		return array
	},


	reuseInnerCom (com, value, key, index) {
		let {keyKey, indexKey, valueAssigner} = this.loop

		if (keyKey) {
			com[keyKey] = key
		}

		if (indexKey) {
			com[indexKey] = index
		}

		if (valueAssigner) {
			valueAssigner.call(com, value)
		}
	},


	reuseOuterCom (com, value, key, index) {
		let {vm} = this
		let {keyKey, indexKey, valueAssigner} = this.loop
		let target = com[targetSymbol]

		target.__proto__ = vm[targetSymbol]
		target._parent = vm
		vm._children.push(target)

		if (keyKey) {
			com[keyKey] = key
		}

		if (indexKey) {
			com[indexKey] = index
		}

		if (valueAssigner) {
			valueAssigner.call(com, value)
		}

		com._setActive()
		com.digest()
	},


	createCom (prevEl, value, key, index, isFirstTimeRendering) {
		let {valueAssigner, keyKey, indexKey} = this.loop
		let {linkEl, linkFn} = this
		let newEl = linkEl.cloneNode(true)

		prevEl.after(newEl)

		let options = {
			el: newEl,
			refs: {},
			_linkFn: linkFn,
		}

		if (keyKey) {
			options[keyKey] = key
		}

		if (indexKey) {
			options[indexKey] = index
		}

		if (valueAssigner) {
			valueAssigner.call(options, value)
		}

		let com = this.vm.newInheritedComponent(options)

		if (!isFirstTimeRendering) {
			let transition = com.el[transitionSymbol]
			if (transition) {
				transition.enterAfterUpdated()
			}
		}

		this.coms.splice(index, 0, com)
		this.map.set(value, com)

		return com
	},


	willRemoveComs (coms) {
		let {willCreate} = this.__proto__
		let {keyKey, indexKey, valueAssigner} = this.loop
		let comSet = new Set()

		if (coms.length && willCreate.length > 0) {
			for (let i = 0, len = Math.min(coms.length, willCreate.length); i < len; i++) {
				let {dir, prevEl, value, key, index} = willCreate.shift()
				let com = coms.shift()

				comSet.add(com[targetSymbol])

				prevEl.after(com.el)
				dir.reuseOuterCom(com, value, key, index)
				dir.coms.splice(index, 0, com)
				dir.map.set(value, com)

				let nextWillCreateOptions = willCreate[0]
				if (nextWillCreateOptions && !nextWillCreateOptions.prevEl) {
					nextWillCreateOptions.prevEl = com.el
				}
			}

			for (let children = this.vm._children, i = children.length - 1; i >= 0; i--) {
				let comTarget = children[i]
				if (comSet.has(comTarget)) {
					children.splice(i, 1)
				}
			}
		}

		if (coms.length > 0) {
			this.recycleComs(coms)
		}
	},


	recycleComs (coms) {
		let {willRemove} = this.__proto__
		let comSet = new Set()

		for (let com of coms) {
			comSet.add(com[targetSymbol])

			com._setInactive()
			willRemove.push({dir: this, com})

			for (let dir of com._directives) {
				if (dir.name === 'for') {
					dir.__proto__.willUpdateDir(dir)
					dir.recycleComs(dir.coms)
				}
			}
		}

		for (let children = this.vm._children, i = children.length - 1; i >= 0; i--) {
			let comTarget = children[i]
			if (comSet.has(comTarget)) {
				children.splice(i, 1)
			}
		}
	},


	removeCom (com) {
		let transition = com.el[transitionSymbol]
		if (transition) {
			transition.leaveAfterUpdated((finish) => {
				com.destroy()
			})
		}
		else {
			com.destroy()
		}
	},
})



//used to skip compiling
FF.registerDirective('skip', {
	isTerminal: true,
	priority: 1000,
})



window.FF = FF



})(ff);