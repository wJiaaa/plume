/** 一个临界阻尼弹簧的状态：位置和速度（每毫秒）。贴底追赶（`useFollowBottom`）和行露出（`useRevealRows`）共用。 */
export interface Spring {
	at: number;
	speed: number;
}

/** 临界阻尼弹簧朝 `target` 走 `dt` 毫秒的精确解，步长再大也不会冲过头或者发散。 */
export function advance(spring: Spring, target: number, omega: number, dt: number): void {
	const offset = spring.at - target;
	const decay = Math.exp(-omega * dt);
	const pull = spring.speed + omega * offset;
	spring.at = target + (offset + pull * dt) * decay;
	spring.speed = (spring.speed - omega * pull * dt) * decay;
}
