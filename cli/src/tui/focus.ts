export class FocusRing {
	private items: string[] = [];
	private idx = 0;

	register(id: string) {
		this.items.push(id);
	}
	clear()              {
		this.items = []; this.idx = 0;
	}
	current()            {
		return this.items[this.idx] ?? '';
	}
	isFocused(id: string) {
		return this.current() === id;
	}

	next() {
		if (this.items.length) this.idx = (this.idx + 1) % this.items.length;
	}
	prev() {
		if (this.items.length) this.idx = (this.idx - 1 + this.items.length) % this.items.length;
	}

	setById(id: string) {
		const i = this.items.indexOf(id);
		if (i !== -1) this.idx = i;
	}
}
