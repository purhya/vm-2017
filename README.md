# vm-2017

In 2017, I have used AngularJS and VueJS for a couple of years, but also met many problems. So I decided to implement a new library.

This library contains 4k lines of codes, and focus on component implementation. It successfully uses **Proxy APIs** to track object properties.

This library was used in a phone manager app, and some internal projects.



### Examples

```js
FF.registerComponent('switch', {

	template: `
		<div class="switch" :class.switch-on="value" @click="onClick">
			<div class="switch-ball"></div>
		</div>
	`,

	value: false, 

	onClick () {
		this.value = !this.value
	},
})
```



### Look back

There are still many problems with this library, e.g.:

- Needs to compile template strings to functions in runtime, delays first paint.
- The proxy based tracking affect performance much, and hard to debug.
- Chooses tracking for dependencies per expression, not per component, so it can update smaller range each time after a few dependencies changed, but cause whole dependency map items explosive increase.
