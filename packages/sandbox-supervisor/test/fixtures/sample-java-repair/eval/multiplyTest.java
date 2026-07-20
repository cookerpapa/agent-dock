public final class multiplyTest {
    public static void main(String[] args) {
        if (Calculator.multiply(6, 7) != 42) throw new AssertionError("multiply");
        System.out.println("multiply passed");
    }
}
